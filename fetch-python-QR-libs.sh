#!/usr/bin/env bash
set -e

PYVER=3.9; ABI=cp${PYVER//./}          # 3.11 -> cp311, 3.9 -> cp39
python3 -m pip download --only-binary=:all: --python-version "$PYVER" --implementation cp \
  --abi "$ABI" --abi abi3 --abi none \
  --platform manylinux_2_28_x86_64 --platform manylinux_2_27_x86_64 --platform manylinux2014_x86_64 \
  "opencv-python>=4.8,<5" numpy -d wheels
mkdir pylibs && for w in wheels/*.whl; do unzip -q "$w" -d pylibs; done
rm -rf wheels
