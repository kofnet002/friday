from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.chat import router as chat_router
from app.api.context import router as context_router
from app.api.vision import router as vision_router
from app.api.ws_answer import router as ws_answer_router
from app.api.ws_coding import router as ws_coding_router
from app.api.ws_transcribe import router as ws_transcribe_router
from app.db import init_db
from app.logging import configure_logging, log
from app.redis_client import close_redis

configure_logging()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await init_db()
    log.info("backend.startup", host="127.0.0.1", port=8000)
    yield
    await close_redis()
    log.info("backend.shutdown")


app = FastAPI(title="Friday Backend", version="0.0.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3333", "http://127.0.0.1:3333"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)
app.include_router(context_router)
app.include_router(vision_router)
app.include_router(ws_transcribe_router)
app.include_router(ws_answer_router)
app.include_router(ws_coding_router)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
