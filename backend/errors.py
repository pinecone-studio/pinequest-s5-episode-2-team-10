"""Every error is returned as {"code", "message"}; the UI shows the message as is."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

log = logging.getLogger("pitchcoach")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def not_found(what: str = "Session") -> ApiError:
    return ApiError(404, "not_found", f"{what} not found.")


def _body(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError):
        return JSONResponse(_body(e.code, e.message), status_code=e.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, e: RequestValidationError):
        first = e.errors()[0] if e.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "request"
        return JSONResponse(_body("invalid_request", f"Invalid {field}: {first.get('msg', 'bad value')}."), status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, e: HTTPException):
        code = "not_found" if e.status_code == 404 else f"http_{e.status_code}"
        return JSONResponse(_body(code, str(e.detail)), status_code=e.status_code)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, e: Exception):
        log.exception("Unhandled error")
        return JSONResponse(_body("internal", "Something went wrong on the server."), status_code=500)
