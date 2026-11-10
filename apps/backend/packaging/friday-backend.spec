# Build from apps/backend with `pnpm --filter @friday/backend build:binary`.
from PyInstaller.utils.hooks import collect_submodules
from pathlib import Path

backend_root = Path(SPECPATH).parent.resolve()

hiddenimports = collect_submodules("app") + collect_submodules("uvicorn")

a = Analysis(
    [str(backend_root / "packaging" / "entrypoint.py")],
    pathex=[str(backend_root)],
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
