"""Import one backed-up local SQLite database and its session files into Supabase."""

import argparse
import logging
import mimetypes
from pathlib import Path, PureWindowsPath
from typing import Any

from sqlalchemy import inspect
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, create_engine, select

from backend import db, storage
from backend.db import (
    AccessToken,
    AnalysisReport,
    AppUser,
    AudioAsset,
    PitchSession,
    Project,
    Slide,
    Transcript,
)

log = logging.getLogger("saylo.migrate")
MODEL_ORDER = (
    AppUser,
    AccessToken,
    Project,
    PitchSession,
    AudioAsset,
    Slide,
    Transcript,
    AnalysisReport,
)


def _parse_user_mappings(values: list[str]) -> dict[str, str]:
    mappings: dict[str, str] = {}
    for value in values:
        source_id, separator, target_id = value.partition("=")
        if not separator or not source_id.strip() or not target_id.strip():
            raise ValueError(f"Invalid --map-user value {value!r}; use SOURCE_USER_ID=TARGET_USER_ID.")
        source_id, target_id = source_id.strip(), target_id.strip()
        if source_id in mappings:
            raise ValueError(f"Source user {source_id!r} is mapped more than once.")
        mappings[source_id] = target_id
    return mappings


def _read_source(source_engine) -> dict[type, list[Any]]:
    tables = inspect(source_engine)
    records: dict[type, list[Any]] = {}
    with Session(source_engine) as source:
        for model in MODEL_ORDER:
            if not tables.has_table(model.__tablename__):
                records[model] = []
                continue
            try:
                records[model] = source.exec(select(model)).all()
            except SQLAlchemyError as exc:
                raise ValueError(
                    f"Could not read source table {model.__tablename__}; start the current backend "
                    "against a backup copy first so its additive schema updates can run."
                ) from exc
    return records


def _validate_session_id(session_id: str) -> None:
    if (
        not session_id
        or session_id in {".", ".."}
        or Path(session_id).name != session_id
        or PureWindowsPath(session_id).name != session_id
        or ":" in session_id
    ):
        raise ValueError("Source session ID is not a safe storage-folder name.")


def _local_file(stored_path: str, session_id: str, data_dir: Path) -> Path:
    _validate_session_id(session_id)
    if storage.key_from_uri(stored_path):
        raise ValueError("The source SQLite database already contains Storage object keys.")
    expected_dir = (data_dir / "sessions" / session_id).resolve()
    filename = PureWindowsPath(stored_path).name
    if not filename or filename in {".", ".."} or Path(filename).name != filename:
        raise ValueError(f"Stored file for session {session_id} has an unsafe filename.")
    source_path = Path(stored_path)
    resolved = source_path.resolve() if source_path.is_absolute() else expected_dir / filename
    if not resolved.is_file() or not resolved.resolve().is_relative_to(expected_dir):
        resolved = (expected_dir / filename).resolve()
    if not resolved.is_relative_to(expected_dir):
        raise ValueError(f"Stored file for session {session_id} is outside its expected session folder.")
    if not resolved.is_file():
        raise ValueError(f"Missing source file for session {session_id}: {resolved.name}")
    return resolved


def _plan_files(records: dict[type, list[Any]], data_dir: Path) -> list[tuple[str, Path, str]]:
    files: list[tuple[str, Path, str]] = []
    for asset in records[AudioAsset]:
        original = _local_file(asset.original_path, asset.session_id, data_dir)
        converted = _local_file(asset.path, asset.session_id, data_dir)
        suffix = original.suffix.lower()
        files.extend(
            (
                (f"sessions/{asset.session_id}/original{suffix}", original,
                 mimetypes.guess_type(original.name)[0] or "application/octet-stream"),
                (f"sessions/{asset.session_id}/audio.wav", converted, "audio/wav"),
            )
        )

    for attempt in records[PitchSession]:
        _validate_session_id(attempt.id)
        if not attempt.slides_filename:
            continue
        suffix = Path(attempt.slides_filename).suffix.lower()
        expected = data_dir / "sessions" / attempt.id / f"slides{suffix}"
        slide_file = _local_file(str(expected), attempt.id, data_dir)
        files.append(
            (
                f"sessions/{attempt.id}/slides{suffix}",
                slide_file,
                mimetypes.guess_type(slide_file.name)[0] or "application/octet-stream",
            )
        )
    return files


def _primary_key(model: type, row: Any) -> Any:
    values = tuple(getattr(row, column.name) for column in model.__table__.primary_key.columns)
    return values[0] if len(values) == 1 else values


def _validate_destination(
    destination: Session,
    records: dict[type, list[Any]],
    user_mappings: dict[str, str],
) -> dict[str, str]:
    source_user_ids = {user.id for user in records[AppUser]}
    unknown_sources = set(user_mappings) - source_user_ids
    if unknown_sources:
        raise ValueError(f"User mapping references unknown source IDs: {', '.join(sorted(unknown_sources))}")

    for _source_id, target_id in user_mappings.items():
        if destination.get(AppUser, target_id) is None:
            raise ValueError(f"Mapped destination user {target_id!r} does not exist in the shared database.")

    user_map = {user.id: user_mappings.get(user.id, user.id) for user in records[AppUser]}
    for user in records[AppUser]:
        target_id = user_map[user.id]
        existing_user = destination.get(AppUser, target_id)
        if existing_user and user.id not in user_mappings:
            raise ValueError(
                f"Destination user ID {target_id!r} already exists; use --map-user "
                "to explicitly map it or choose another source."
            )
        if existing_user and user.token_hash != existing_user.token_hash:
            existing_alias = destination.get(AccessToken, user.token_hash)
            primary_owner = destination.exec(
                select(AppUser).where(AppUser.token_hash == user.token_hash)
            ).first()
            if (existing_alias and existing_alias.user_id != target_id) or (
                primary_owner and primary_owner.id != target_id
            ):
                raise ValueError("A source user's token conflicts with a different destination account.")
        if user.email:
            existing_email = destination.exec(
                select(AppUser).where(AppUser.email == user.email)
            ).first()
            if existing_email and existing_email.id != target_id:
                raise ValueError(
                    f"Email {user.email!r} already belongs to a different destination user; "
                    f"map source user {user.id} with --map-user {user.id}={existing_email.id}."
                )
        primary_owner = destination.exec(
            select(AppUser).where(AppUser.token_hash == user.token_hash)
        ).first()
        if primary_owner and primary_owner.id != target_id:
            raise ValueError("A source user's primary token conflicts with a different destination account.")
        existing_alias = destination.get(AccessToken, user.token_hash)
        if existing_alias and existing_alias.user_id != target_id:
            raise ValueError("A source user's token conflicts with a different destination account.")

    for model in MODEL_ORDER:
        if model in (AppUser, AccessToken):
            continue
        for row in records[model]:
            key = _primary_key(model, row)
            if destination.get(model, key) is not None:
                raise ValueError(
                    f"Destination already contains a {model.__tablename__} row with primary key {key!r}."
                )

    for row in records[AccessToken]:
        mapped_user_id = user_map.get(row.user_id, row.user_id)
        if destination.get(AppUser, mapped_user_id) is None:
            raise ValueError(f"Access token references missing source user {row.user_id!r}.")
        existing_alias = destination.get(AccessToken, row.token_hash)
        if existing_alias and existing_alias.user_id != mapped_user_id:
            raise ValueError("A source access token already exists in the destination.")
        existing_user = destination.exec(
            select(AppUser).where(AppUser.token_hash == row.token_hash)
        ).first()
        if existing_user and existing_user.id != mapped_user_id:
            raise ValueError("A source access token conflicts with a destination user's primary token.")
    return user_map


def _copy_rows(
    records: dict[type, list[Any]],
    user_map: dict[str, str],
    destination: Session,
) -> list[Any]:
    rows: list[Any] = []
    for model in MODEL_ORDER:
        for source_row in records[model]:
            values = source_row.model_dump()
            if model is AppUser:
                mapped_id = user_map[source_row.id]
                existing_user = destination.get(AppUser, mapped_id)
                if existing_user:
                    if (
                        existing_user.token_hash != source_row.token_hash
                        and destination.get(AccessToken, source_row.token_hash) is None
                    ):
                        rows.append(
                            AccessToken(
                                token_hash=source_row.token_hash,
                                user_id=mapped_id,
                                created_at=source_row.created_at,
                            )
                        )
                    continue
            elif model is AccessToken:
                values["user_id"] = user_map.get(source_row.user_id, source_row.user_id)
                existing_alias = destination.get(AccessToken, source_row.token_hash)
                if existing_alias and existing_alias.user_id == values["user_id"]:
                    continue
                existing_user = destination.exec(
                    select(AppUser).where(AppUser.token_hash == source_row.token_hash)
                ).first()
                if existing_user and existing_user.id == values["user_id"]:
                    continue
            elif model is Project:
                values["user_id"] = user_map[source_row.user_id]
            elif model is AudioAsset:
                suffix = Path(source_row.original_path).suffix.lower()
                values["path"] = storage.uri_for(f"sessions/{source_row.session_id}/audio.wav")
                values["original_path"] = storage.uri_for(
                    f"sessions/{source_row.session_id}/original{suffix}"
                )
            rows.append(model.model_validate(values))
    return rows


def migrate(source_db: Path, data_dir: Path, user_mappings: dict[str, str], dry_run: bool) -> None:
    source_db = source_db.resolve()
    data_dir = data_dir.resolve()
    if not source_db.is_file():
        raise ValueError(f"Source SQLite database does not exist: {source_db}")
    if db.engine.dialect.name != "postgresql":
        raise ValueError("PITCH_DB_URL must point to the shared Supabase PostgreSQL database.")
    storage.validate_configuration(required=True)
    if not dry_run:
        db.init()

    source_engine = create_engine(URL.create("sqlite", database=str(source_db)))
    try:
        records = _read_source(source_engine)
        files = _plan_files(records, data_dir)
        with Session(db.engine) as destination:
            user_map = _validate_destination(destination, records, user_mappings)
            copied_rows = _copy_rows(records, user_map, destination)
            if dry_run:
                counts = ", ".join(
                    f"{model.__tablename__}={len(records[model])}" for model in MODEL_ORDER
                )
                print(
                    f"Dry run only; no rows or files changed. {counts}; "
                    f"rows_to_import={len(copied_rows)}; files={len(files)}"
                )
                return

        uploaded_keys: list[str] = []
        try:
            for key, path, content_type in files:
                storage.upload_file(key, path, content_type, upsert=False)
                uploaded_keys.append(key)
            with Session(db.engine) as destination:
                destination.add_all(copied_rows)
                destination.commit()
        except Exception:
            if uploaded_keys:
                try:
                    storage.delete_objects(uploaded_keys)
                except storage.StorageError as cleanup_error:
                    log.error("Migration rollback left uploaded objects in Storage: %s", cleanup_error)
            raise
        print(f"Imported rows={len(copied_rows)} and files={len(uploaded_keys)}. Source files were not changed.")
    finally:
        source_engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-db", type=Path, required=True, help="Path to the backed-up pitchcoach.db")
    parser.add_argument("--source-data-dir", type=Path, required=True, help="Path to the matching local data directory")
    parser.add_argument(
        "--map-user",
        action="append",
        default=[],
        metavar="SOURCE_ID=TARGET_ID",
        help="Explicitly attach a source user's projects to an existing shared account; repeat as needed.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate source, mappings, files and conflicts without writing.")
    args = parser.parse_args()

    try:
        migrate(args.source_db, args.source_data_dir, _parse_user_mappings(args.map_user), args.dry_run)
    except (SQLAlchemyError, storage.StorageError, ValueError) as exc:
        raise SystemExit(f"Migration failed: {exc}") from exc


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    main()
