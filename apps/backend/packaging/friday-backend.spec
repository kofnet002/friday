# PyInstaller spec for the packaged backend: `pnpm --filter @friday/backend build:binary`.
# Produces dist/friday-backend/ (onedir — starts much faster than onefile,
# which unpacks to a temp dir on every launch).
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules("app") + collect_submodules("uvicorn")

a = Analysis(
    ["../app/server.py"],
    pathex=[".."],
    hiddenimports=hiddenimports,
    excludes=["pytest", "mypy", "ruff"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="friday-backend",
    console=True,
)
coll = COLLECT(exe, a.binaries, a.datas, name="friday-backend")
