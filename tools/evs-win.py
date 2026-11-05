"""EVS oficial aislado: login humano o firma sin salida privada."""
import sys
import os
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "tools/python_runtime/windows"
EXPECTED_PYTHON = "3cce33d75d6fdae4e004d0bdf149320b3147482a9caf370079dcb9c191a1b260"
if (Path(sys.executable).resolve() != (BASE / "python.exe").resolve()
        or sys.version_info[:3] != (3, 10, 11)
        or hashlib.sha256((BASE / "python.exe").read_bytes()).hexdigest() != EXPECTED_PYTHON
        or not sys.flags.no_site or "site" in sys.modules):
    raise SystemExit("Runtime local incompatible; no se usará otro Python.")
DEPS = ROOT / "tools/evs-env-win"
sys.path[:] = [str(DEPS), str(BASE / "python310.zip"), str(BASE)]
os.chdir(ROOT)
for key in list(os.environ):
    if key.startswith(("AWS_", "EVS_", "PYTHON")) or key == "BOTO_CONFIG":
        del os.environ[key]
private = ROOT / ".local/evs"
private.mkdir(exist_ok=True)
for name in ("aws-config-empty", "aws-credentials-empty", "boto-config-empty"):
    (private / name).write_text("", encoding="utf-8")
os.environ.update({
    "EVS_CONFIG_FILE": str(private / "config.json"),
    "EVS_CACHE_FILE": str(private / "cache.json"),
    "AWS_EC2_METADATA_DISABLED": "true",
    "AWS_CONFIG_FILE": str(private / "aws-config-empty"),
    "AWS_SHARED_CREDENTIALS_FILE": str(private / "aws-credentials-empty"),
    "BOTO_CONFIG": str(private / "boto-config-empty"),
    "TEMP": str(private), "TMP": str(private),
})

import json
import contextlib
import io
import runpy
import importlib.metadata

action = sys.argv[1] if len(sys.argv) > 1 else "check"
if action == "account":
    if not sys.stdin.isatty() or not sys.stdout.isatty() or len(sys.argv) != 2:
        raise SystemExit("Ingresar credenciales sólo en una terminal humana interactiva.")
    sys.argv[:] = ["castlabs_evs.account", "reauth"]
    runpy.run_module("castlabs_evs.account", run_name="__main__")
elif action == "check":
    import castlabs_evs.vmp
    lock = ROOT / "tools/evs-requirements-win-x64.txt"
    versions = {}
    for line in lock.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        name, expected = line.split()[0].split("==")
        dist = importlib.metadata.distribution(name)
        if dist.version != expected or not Path(dist.locate_file("")).resolve().is_relative_to(DEPS):
            raise SystemExit("Dependencia local incompatible.")
        versions[name] = dist.version
    origins = {}
    for name, module in list(sys.modules.items()):
        filename = getattr(module, "__file__", None)
        if filename and name not in ("__main__", "__mp_main__"):
            location = Path(filename).resolve()
            if not location.is_relative_to(BASE) and not location.is_relative_to(DEPS):
                raise SystemExit("Módulo fuera del entorno aislado: " + name)
            if location.is_relative_to(DEPS):
                origins[name] = "tools/evs-env-win"
    print(json.dumps({"ok": True, "python": "3.10.11", "dependencies": versions,
                      "site": "site" in sys.modules, "no_site": sys.flags.no_site,
                      "foreignStartup": any(n in sys.modules for n in ("_distutils_hack", "zope")),
                      "dependencyModules": len(origins)}))
elif action == "account-pipe" and len(sys.argv) == 2:
    if sys.stdin.isatty() or sys.stdout.isatty() or sys.stderr.isatty():
        raise SystemExit("El diálogo humano debe usar un pipe privado.")
    sys.stdin.reconfigure(encoding="utf-8")
    payload = None
    client = None
    output = io.StringIO()
    result = {"ok": False, "category": "invalid-input"}
    try:
        payload = json.loads(sys.stdin.read(8193))
        if (not isinstance(payload, dict) or set(payload) != {"accountName", "password"}
                or not isinstance(payload["accountName"], str) or not 1 <= len(payload["accountName"]) <= 128
                or not isinstance(payload["password"], str) or not 1 <= len(payload["password"]) <= 1024):
            raise ValueError("invalid-input")
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            from castlabs_evs.account import Account
            client = Account(no_ask=True)
            client.reauth(account_name=payload["accountName"], passwd=payload["password"])
        result = {"ok": True, "category": "authenticated"}
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        category = {
            "NotAuthorizedException": "invalid-credentials",
            "UserNotFoundException": "account-not-found",
            "UserNotConfirmedException": "account-not-confirmed",
            "PasswordResetRequiredException": "password-reset-required",
            "TooManyRequestsException": "rate-limited",
            "InvalidParameterException": "invalid-input",
        }.get(code, {
            "EndpointConnectionError": "connection-error", "ConnectTimeoutError": "connection-error",
            "ReadTimeoutError": "connection-error", "JSONDecodeError": "invalid-input",
            "ValueError": "invalid-input",
        }.get(type(error).__name__, "unknown-error"))
        result = {"ok": False, "category": category}
    finally:
        # Referencias liberadas; strings en memoria administrada no admiten borrado garantizado.
        payload = client = None
        output.close()
    (private / "login-status.json").write_text(json.dumps(result) + "\n", encoding="utf-8")
    print(json.dumps(result))
    raise SystemExit(0 if result["ok"] else 1)
elif action in ("sign", "verify") and len(sys.argv) == 3:
    candidate = Path(sys.argv[2]).resolve()
    # El cliente verify puede mover firmas: nunca usarlo sobre la app humana activa.
    if (candidate.name != "win-unpacked" or not candidate.parent.name.startswith("staging-win-x64-evs-candidate-")
            or candidate.parent.parent != ROOT / "release" or candidate.is_symlink()
            or not (candidate / ".lga-staging").is_file() or (candidate / "data").exists()):
        raise SystemExit("Se requiere candidato propio sin perfil humano.")
    os.environ["EVS_NO_ASK"] = "1"
    output = io.StringIO()
    result = {"action": action, "ok": False, "streaming": True, "production": False}
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            from castlabs_evs.vmp import VMP
            client = VMP(no_ask=True, any_ski=False)
            if action == "sign":
                client.sign_pkg(str(candidate), name_hint="LGA_El_Music", kind="streaming", min_days=90)
            client.verify_pkg(str(candidate), name_hint="LGA_El_Music", kind="streaming", min_days=90)
        result.update(ok=True, production=True)
    except Exception as error:
        # No devolver mensajes crudos: pueden incluir valores de cuenta o URLs firmadas.
        result["errorType"] = type(error).__name__
    finally:
        output.close()
    print(json.dumps(result))
    raise SystemExit(0 if result["ok"] else 1)
else:
    raise SystemExit("Acción inválida: check, account, account-pipe, sign o verify.")
