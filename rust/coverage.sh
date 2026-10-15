#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Library-only report. Test modules next to the validator are excluded;
# implementation files are not. LLVM does not emit a usable branch column
# on this toolchain, so the gate is lines + functions.
exec cargo llvm-cov --offline --summary-only \
  --ignore-filename-regex '(samples_test|parity_test|semantics_parity)\.rs' \
  --fail-under-lines 100 \
  --fail-under-functions 100 \
  "$@"
