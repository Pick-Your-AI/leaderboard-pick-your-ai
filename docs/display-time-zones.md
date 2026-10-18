# Display timezones and exact UTC bounds

The browser's **Display timezone** control changes how the selected interval is
read. Event inclusion, date inputs, rolling and calendar periods, source queries,
signed cursors, and exported data continue to use their existing UTC semantics.
This implements the selected-timezone display portion of
[LB11.02 / #91](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/91).
It does not establish acceptance of the issue's remaining scope filters or
project aggregation requirements.

## Reading and sharing a window

The optional `tz` query parameter stores the display preference, for example
`tz=America%2FNew_York`. UTC is the default and is omitted from generated links.
The picker uses the browser's supported IANA timezones and retains a supported
alias from a copied link. The selected zone survives navigation, browser
Back/Forward, copied URLs, and wall links.

The scope and provenance panels display the start as inclusive and the end as
exclusive in the chosen timezone, including milliseconds and a numeric UTC
offset. The offset distinguishes repeated local times during a daylight-saving
transition. Exact ISO UTC bounds remain visible, and each rendered `time`
element retains its original instant in `datetime`. Gregorian dates near the
BC/AD boundary retain their era after timezone conversion.

The prototype's regular scope panel and fullscreen wall both show this display.
The API application's provenance and wall also show it. An absent API bound
remains explicitly absent; the browser does not infer a source cutoff from the
publication's generation timestamp.

Changing the API display timezone copies the current URL selection and pins the
snapshot actually being viewed when the URL has no explicit pin. It preserves
the current cursor and open proof, including when another snapshot has just
been published. The existing exact-scope form retains the display preference
when a reader intentionally changes the source selection.

## Validation and data boundary

A display zone must be a supported, bounded identifier: no more than 128
characters, a syntactically valid identifier, and accepted by the runtime's
`Intl.DateTimeFormat`. Empty, duplicate, malformed, and unsupported `tz` values
produce a visible validation message. The API UI rejects them before a source
read. The prototype explicitly falls back to UTC while retaining its selected
UTC window.

The display parameter is not sent to the service or portfolio/export query
builders. It does not change cache identities, aggregation membership, source
authorization, calendar boundaries, or the half-open interval rule
`start <= event time < end`.

## Regression coverage

- [Timezone formatting tests](../apps/web/test/display-time-zone.test.ts)
  cover the spring clock jump, repeated autumn hour, non-hour offsets, supported
  aliases, invalid inputs, early Gregorian years, and unchanged UTC inclusion.
- [Scope tests](../apps/web/test/display-time-zone-scope.test.ts) cover URL
  persistence and the separation between display preferences and service queries.
- [Browser tests](../apps/web/browser/display-time-zone.spec.ts) exercise the
  prototype and the actual Fastify handler with synthetic publications: pinned
  navigation/history, newer publications, cursor/proof retention, both walls,
  invalid-input source-read exclusion, and 320px reflow with automated
  accessibility checks.

These tests demonstrate the implemented behavior using synthetic data. They do
not certify real source collection, a production deployment, or all accessibility
acceptance for the product. Browser CI uses the repository's locked Playwright
browser and normal required workflow.
