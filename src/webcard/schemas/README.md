These JSON Schema files are vendored verbatim from Webcard Format 1.0.0:
https://github.com/reggi/webcard/tree/main/spec/1.0.0/schemas

Their immutable `$id` values identify the published version. Procedural validation
in `../format.js` additionally enforces ZIP structure, cross-file references,
timestamps, resource limits, image type, and SHA-256 integrity.
