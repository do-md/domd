#!/bin/bash
# Inject UTImportedTypeDeclarations for net.daringfireball.markdown into a
# Tauri-built DOMD.app Info.plist. Required so the bundled QuickLook preview
# extension's QLSupportedContentTypes can resolve the UTI.
#
# Usage: inject-uti.sh /path/to/DOMD.app/Contents/Info.plist

set -euo pipefail

INFO_PLIST="${1:?Usage: $0 <Info.plist>}"
if [ ! -f "$INFO_PLIST" ]; then
    echo "Error: $INFO_PLIST not found" >&2
    exit 1
fi

UTI_JSON='[
  {
    "UTTypeIdentifier": "net.daringfireball.markdown",
    "UTTypeDescription": "Markdown",
    "UTTypeConformsTo": ["public.plain-text"],
    "UTTypeTagSpecification": {
      "public.filename-extension": ["md", "markdown"],
      "public.mime-type": ["text/markdown"]
    }
  }
]'

plutil -remove UTImportedTypeDeclarations "$INFO_PLIST" 2>/dev/null || true
plutil -insert UTImportedTypeDeclarations -json "$UTI_JSON" "$INFO_PLIST"

echo "Injected UTImportedTypeDeclarations into $INFO_PLIST"
