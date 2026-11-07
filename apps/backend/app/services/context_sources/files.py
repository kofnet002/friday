"""Uploaded documents: PDF, DOCX, Markdown / plain text / source code."""

from __future__ import annotations

import io

from app.services.context_sources import Ingested, IngestError, cap

TEXT_EXTENSIONS = frozenset(
    {
        ".md", ".markdown", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml",
        ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs", ".java",
        ".kt", ".swift", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".hpp",
        ".sql", ".sh", ".html", ".css", ".scss", ".vue", ".svelte", ".jsonl",
        ".diff", ".patch", ".csv",
    }
)  # fmt: skip


def extract_pdf(data: bytes) -> str:
    import fitz  # PyMuPDF

    parts: list[str] = []
    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            parts.append(page.get_text())
    return "\n".join(parts)


def extract_docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    return "\n".join(p.text for p in document.paragraphs if p.text)


def ingest_file(filename: str, content_type: str | None, data: bytes) -> Ingested:
    if not data:
        raise IngestError("empty file")
    name = filename.lower()
    ctype = content_type or ""
    if name.endswith(".pdf") or ctype.endswith("pdf"):
        text = extract_pdf(data)
    elif name.endswith(".docx") or "wordprocessingml" in ctype:
        text = extract_docx(data)
    elif any(name.endswith(ext) for ext in TEXT_EXTENSIONS) or ctype.startswith("text/"):
        text = data.decode("utf-8", errors="replace")
    else:
        raise IngestError("unsupported file type — upload PDF, DOCX, Markdown, text or code")
    text = text.strip()
    if not text:
        raise IngestError("no text extracted")
    text, truncated = cap(text)
    return Ingested(title=filename, text=text, meta={"truncated": truncated})
