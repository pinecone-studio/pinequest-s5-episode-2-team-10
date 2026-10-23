import pytest
from sqlmodel import Session, SQLModel, create_engine

from backend.db import AccessToken, AppUser, AudioAsset, AnalysisReport, PitchSession, Project, Slide, Transcript
from scripts.migrate_local_data import _copy_rows, _local_file, _parse_user_mappings, _validate_destination


def test_parse_user_mappings_requires_unique_source_ids():
    assert _parse_user_mappings(["local-a=shared-a", "local-b=shared-b"]) == {
        "local-a": "shared-a",
        "local-b": "shared-b",
    }
    with pytest.raises(ValueError, match="more than once"):
        _parse_user_mappings(["local-a=shared-a", "local-a=shared-b"])
    with pytest.raises(ValueError, match="SOURCE_USER_ID=TARGET_USER_ID"):
        _parse_user_mappings(["not-a-mapping"])


def test_local_file_does_not_read_paths_outside_the_attempt_folder(tmp_path):
    data_dir = tmp_path / "data"
    attempt_dir = data_dir / "sessions" / "attempt-1"
    attempt_dir.mkdir(parents=True)
    audio = attempt_dir / "audio.wav"
    audio.write_bytes(b"audio")

    assert _local_file(str(audio), "attempt-1", data_dir) == audio.resolve()
    with pytest.raises(ValueError, match="Missing source file"):
        _local_file(str(tmp_path / "other.wav"), "attempt-1", data_dir)


def test_local_file_rebases_windows_paths_from_another_computer(tmp_path):
    data_dir = tmp_path / "data"
    attempt_dir = data_dir / "sessions" / "attempt-1"
    attempt_dir.mkdir(parents=True)
    audio = attempt_dir / "audio.wav"
    audio.write_bytes(b"audio")

    source_machine_path = r"C:\Users\teammate\saylo\data\sessions\attempt-1\audio.wav"

    assert _local_file(source_machine_path, "attempt-1", data_dir) == audio.resolve()


def test_import_mapping_preserves_owner_and_converts_audio_paths():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    source_user = AppUser(id="local-user", token_hash="local-token-hash")
    source_audio = AudioAsset(
        session_id="attempt-1",
        path=r"C:\backup\data\sessions\attempt-1\audio.wav",
        original_path=r"C:\backup\data\sessions\attempt-1\upload.mp3",
        duration_s=10,
        format="mp3",
    )
    records = {
        AppUser: [source_user],
        AccessToken: [],
        Project: [],
        PitchSession: [],
        AudioAsset: [source_audio],
        Slide: [],
        Transcript: [],
        AnalysisReport: [],
    }
    with Session(engine) as destination:
        target_user = AppUser(id="shared-user", token_hash="shared-token-hash")
        destination.add(target_user)
        destination.commit()

        user_map = _validate_destination(destination, records, {"local-user": "shared-user"})
        copied_rows = _copy_rows(records, user_map, destination)

    alias = next(row for row in copied_rows if isinstance(row, AccessToken))
    audio = next(row for row in copied_rows if isinstance(row, AudioAsset))
    assert alias.user_id == "shared-user"
    assert audio.path == "storage://sessions/attempt-1/audio.wav"
    assert audio.original_path == "storage://sessions/attempt-1/original.mp3"


def test_local_file_must_exist(tmp_path):
    data_dir = tmp_path / "data"
    (data_dir / "sessions" / "attempt-1").mkdir(parents=True)

    with pytest.raises(ValueError, match="Missing source file"):
        _local_file(str(data_dir / "sessions" / "attempt-1" / "audio.wav"), "attempt-1", data_dir)


def test_local_file_rejects_path_traversal_session_id(tmp_path):
    with pytest.raises(ValueError, match="safe storage-folder name"):
        _local_file("audio.wav", "..", tmp_path)
