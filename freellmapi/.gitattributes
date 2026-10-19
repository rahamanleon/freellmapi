# Normalize line endings in the repository to LF.
#
# Without this, Git for Windows' default `core.autocrlf=true` checks text files
# out with CRLF. That is not cosmetic here: server/src/app.ts pins
# INLINE_BOOTSTRAP_SHA, the SHA-256 of the inline theme bootstrap in
# client/index.html, and serves it in the CSP `script-src` directive. A CRLF
# checkout changes those bytes, so the hash no longer matches the script it is
# meant to authorize — the browser blocks the bootstrap and dark-mode users get
# the white flash that #682 fixed. csp-inline-bootstrap.test.ts catches it, but
# only after a Windows clone already fails two tests out of the box.
*               text=auto eol=lf

# Binary assets must never be line-ending converted.
*.png           binary
*.jpg           binary
*.jpeg          binary
*.gif           binary
*.ico           binary
*.webp          binary
*.woff          binary
*.woff2         binary
*.ttf           binary
*.eot           binary
*.pdf           binary
*.zip           binary
*.node          binary
*.db            binary

# Windows-only scripts are fine either way, but keep them LF for consistency
# with the rest of the tree; PowerShell reads LF without complaint.
*.ps1           text eol=lf
