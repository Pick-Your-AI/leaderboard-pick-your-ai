# CSV download validation

The browser validates both public-export/v1 formats before offering a download. CSV transport success and valid UTF-8 alone do not establish that an export belongs to the displayed snapshot or follows its metric definition.

The CSV reader accepts the service's existing bounded, fully quoted CRLF format with its exact columns, one metadata record and at most the selected page size. Every row must repeat the same metadata. It rejects malformed quoting, extra or duplicate columns, extra metadata records, nonfinite or ambiguous numbers, contradictory evidence bindings, unsafe formula prefixes and missing pending proofs. Quoted commas, Unicode, multiline labels, protected formula text, empty pages and unknown values retain their existing meaning. Valid downloads preserve the original bytes.

The reader reconstructs the minimized public export and applies the same validator used for JSON. That binds scope, snapshot, actor filter and the full metric definition to the current selection and loaded registry, checks page totals and source proofs, and prevents descriptive metrics from gaining personal ranks. Raw counting-rule and unit columns must also match the loaded definition. A contradictory CSV response produces the existing controlled export error without a downloadable Blob.

Both formats reject duplicate decoded JSON keys, unrecognized fields, contradictory regular/pending proof metadata and negative diagnostic observations. This matters because successful downloads retain the original bytes: validating a parsed object while ignoring another field would leave that unprojected content in the file. Duplicate-aware parsing preserves ordinary JSON whitespace, Unicode and escapes; it does not require a particular pretty-printing style. Existing optional actor labels in legacy JSON exports remain optional.

The tests use CSV produced by the actual service handler, then exercise both valid downloads and deliberately altered responses. This is partial implementation evidence for #98, #108 and #110. It does not certify source authorization, historical completeness, contributor approval or a production deployment.
