#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Este bootstrap requiere macOS.' >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64; expected=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  x86_64) arch=x64; expected=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  *) echo 'CPU no soportada.' >&2; exit 1 ;;
esac
base="node-v24.21.0-darwin-$arch"
archive="$PWD/tools/$base.tar.gz"
runtime="$PWD/tools/$base"
[[ ! -e "$runtime" ]] || { echo "Runtime ya existe: $runtime. Verificarlo antes de reemplazarlo." >&2; exit 1; }
mkdir -p "$PWD/tools"
/usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "https://nodejs.org/dist/v24.21.0/$base.tar.gz"
actual=$(/usr/bin/shasum -a 256 "$archive" | /usr/bin/awk '{print $1}')
[[ "$actual" == "$expected" ]] || { echo 'Hash Node incorrecto; no se extrajo ni ejecutó.' >&2; exit 1; }
/usr/bin/tar -xzf "$archive" -C "$PWD/tools"
echo "Runtime local verificado: $runtime/bin/node"
