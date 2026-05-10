#!/usr/bin/env bash
set -e
cd "$(dirname \"$0\")"
echo "Installing dependencies if needed..."
pnpm install --silent

echo "Starting dev server..."
pnpm run dev
