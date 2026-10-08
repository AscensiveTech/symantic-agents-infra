# Service-area geography

How `check_service_area` decides whether a caller's location is inside a
business's Service Area Coverage. Code: `lambda/tools/geo/` (resolver,
states, region registry, dataset) and `lambda/tools/handlers/service-area.mjs`
(the webhook). Dataset build: `scripts/build-service-area-geo.mjs`.

## Why it is deterministic

The previous check matched text only. Anything it couldn't match came back
`matched: false` with a hint telling the model to "decide from where the
place actually is". The model's sense of geography then decided coverage,
so the same call could get different answers. The resolver now makes the
decision from a local, versioned copy of Census and OMB geography, and the
prompt tells the agent to follow the returned status rather than its own
judgment.

The normal call path makes **no network call and no database read**. There
is no per-call paid geocoding API. The dataset (~480 KB gzipped) ships inside
the tools Lambda. It is loaded once per container on the first service-area
call, which takes ~130 ms on a laptop and somewhat longer at 256 MB Lambda.
After that a check takes about a millisecond. Coverage data changes about
once a year, so paying per lookup for a geocoder would add cost, latency
and a failure mode for no gain in accuracy.

## Result contract

```json
{
  "ok": true,
  "matched": true,
  "status": "covered | outside | ambiguous | unresolved",
  "canonicalLocation": { "place": "Silver Spring", "state": "MD", "zip": null,
                         "county": "Montgomery County",
                         "metro": "Washington-Arlington-Alexandria, DC-VA-MD-WV" },
  "matchedBy": "zip | place | state | county | metro | region | business_location | null",
  "matchedArea": "Washington DC metro area",
  "confidence": "exact | contextual | ambiguous",
  "message": "That location is within our published service area.",
  "clarificationQuestion": ""
}
```

- `matched` is `status === "covered"`. It is kept, along with `ok`, for agents
  published before `status` existed. Those agents keep their old prompt until
  their next Save Changes.
- `matchedArea` is the configured entry exactly as the business typed it.
  It reads "the business's own town" for `business_location`.
- `confidence` is `exact` when the caller's words point at one place ("Silver
  Spring, MD", a ZIP). It is `contextual` when the business's context chose
  between same-named places or a fully covered/uncovered state decided.
  It is `ambiguous` for `ambiguous` and `unresolved`.
- `outside` always carries the team-confirmation line: "Our team confirms
  coverage for addresses out that way. I can take your details and have them
  follow up."
- Optional `suggestion` ("Silver Spring, MD") accompanies a likely
  mishearing. Optional `candidates` lists the readings behind an `ambiguous`
  result.

## Datasets and versions

Built by `scripts/build-service-area-geo.mjs` into
`lambda/tools/geo/data/us-geo.txt.gz`. `manifest.json` next to it records
the dataset version, the SHA-256 of every source file and of the output,
and row counts. A test fails if the file and the manifest disagree.

| Data | Source | Vintage |
|---|---|---|
| States, USPS abbreviations, FIPS codes, Census regions and divisions | Census Bureau (in code: `geo/states.mjs`) | stable |
| Counties and county equivalents (incl. Connecticut planning regions) | Census Gazetteer `2026_Gaz_counties_national` | 2026 |
| Places (incorporated places and CDPs) | Census Gazetteer `2026_Gaz_place_national` | 2026 |
| Towns and townships with an active government (New England, NY, NJ, PA, Midwest townships) | Census Gazetteer `2026_Gaz_cousubs_national`, FUNCSTAT A/B/C | 2026 |
| ZIP codes (as ZCTAs) | Census Gazetteer `2026_Gaz_zcta_national` (2020 ZCTA5) | 2020 ZCTAs |
| Place -> county | Census `national_place_by_county2020` | 2020 |
| ZCTA -> county, ZCTA -> place | Census 2020 relationship files `tab20_zcta520_county20`, `tab20_zcta520_place20` | 2020 |
| Connecticut ZCTA -> planning region | Census `acs22_cousub22_zcta520_st09` | 2022 |
| Metropolitan / micropolitan (CBSA) and combined (CSA) areas | OMB Bulletin 23-01, Census delineation list 1 (`list1_2023.xlsx`) | July 2023 |
| Informal regions (Northern Virginia, SoCal, DMV, ...) | `geo/regions.mjs`, versioned registry | `REGION_REGISTRY_VERSION` |

Scope: the 50 states and DC. Puerto Rico and the territories are excluded.

Known approximations:

- **ZIP codes vs ZCTAs.** Census ZIP Code Tabulation Areas approximate
  USPS ZIP delivery areas from census blocks. They are not USPS delivery
  boundaries. PO-box-only and single-building ZIPs have no ZCTA, and a few
  ZCTA edges differ from where the mail goes. An exact match against a ZIP the
  business listed always works, ZCTA or not. A ZIP is placed in the
  county holding most of its land; counties with under 10% are dropped.
  So a ZIP that straddles a county line is judged by its main county.
- **Places since 2020.** 516 places in the 2026 Gazetteer aren't in the
  2020 place-by-county file. Each takes the county of the nearest ZCTA
  interior point in the same state.
- **Connecticut.** Since 2022 the county equivalents are 9 planning regions,
  and the 2023 CBSAs use them. CT ZIPs come from the 2022 CT relationship
  file. CT places are assigned via their ZIPs' planning regions.
- Neighbourhoods and unincorporated areas that are not Census places
  ("Capitol Hill", "Georgetown") are not in the dataset. See "Unknown places"
  below.

## How a check runs

1. **Normalize** the caller's words. This lowercases them, strips accents
   and punctuation, and folds "D.C." to "DC" and St./Saint, Ft./Fort, Mt./Mount
   together. It also removes "zip code", treats ZIP+4 as its five-digit base,
   and peels off "metro / metro area / metropolitan area / area / region",
   "greater ..." and "and surrounding areas".
2. **Look up locally**, by precedence:
   1. exact ZIP / ZIP+4 against a listed ZIP;
   2. exact place plus state;
   3. exact configured city / county / state / region;
   4. the business's own town and ZIP (from its address);
   5. inside a configured state;
   6. inside a configured county;
   7. inside a configured metro / combined area;
   8. inside a configured named region;
   9. a state-less town resolved by context;
   10. a clarification question.
   When several configured areas cover the place, `matchedBy` reports the
   highest-ranked one.
3. **Containment** is by county. A state covers all its counties. A metro
   covers its OMB member counties. A region covers its listed states and
   counties minus any excluded counties. A place is covered when all its
   counties are. If only some are (Kansas City across four counties), the
   result is `ambiguous`, asking "What's the ZIP code there?".
4. **Substring false positives are impossible by construction.** Matching is
   on whole normalized names, never substrings. State names are matched
   longest first, so West Virginia is never Virginia. "Washington state",
   "Seattle, Washington" and "WA" are Washington state. "Washington DC",
   "D.C." and "District of Columbia" are DC. A bare "Washington" is both,
   decided by context. A two-letter word like "in", "me" or "or" is a state
   only in capitals, after a comma, or right after a town in that state
   ("Muncie IN"). "Arlington" never matches inside "Darlingtonville".

### State-less towns and ambiguity

For "Silver Spring" the resolver finds every place with that name. It keeps
the readings that are inside a configured area or in the business's own
context: its address state, plus the states the business named outright as a
state, "City, ST", county or ZIP.

- If every remaining reading is covered, the result is `covered`
  (`contextual`).
- If exactly one reading remains, it decides.
- If none remain, every reading is outside, so the result is `outside`. The
  exception is a likely mishearing of a place the business serves ("Silver
  Springs" for a Maryland business). That gets `ambiguous`: "Did you mean
  Silver Spring, Maryland? If not, which state is that in, or what's the ZIP
  code?"
- Otherwise the result is `ambiguous`: "Which state is that in, or what's the
  ZIP code?" (or "What's the ZIP code there?" when the readings share a
  state).

Configured entries get the same treatment. "Charleston" listed alongside
"South Carolina" means Charleston, SC. "Arlington" listed next to "Northern
Virginia" means Arlington, VA. A configured name no context can settle covers
every reading, which is what plain text matching did. The preview marks it
`ambiguous` so it can be fixed.

### Unknown places

A name that isn't in the dataset and isn't a configured entry is
`unresolved`. It is never matched against coverage by guesswork. The tool
returns either "Sorry, did you say Gaithersburg?" when a real place in the
business's states is one or two letters away, or "Could you spell the name of
the town for me, or give me the ZIP code?". The prompt allows two attempts.
If an on-site visit depends on the location, the agent takes a message
instead of booking.

When the caller gives a state with an unknown town ("Blorpville, MD"), the
state alone settles it if it is entirely covered (`covered`, `contextual`)
or entirely unserved (`outside`). The town would not change either answer.
Otherwise it is `unresolved`.

A configured entry the dataset doesn't recognize ("Capitol Hill") is kept as
text. A caller saying those exact words is still covered, as before.

## Regions

Formal regions come from the dataset or from Census definitions and are
expanded mechanically:

- **States** and their abbreviations.
- **Census regions:** Northeast, Midwest, South, West. They also answer to
  "North East", "Mid West", "Midwestern US", "the South" and similar.
- **Census divisions:** "New England", plus "<name> division" and "<name>
  states" ("East North Central states").
- **OMB metropolitan and combined areas**, found by any run of their title
  cities. "DC metro area", "Washington DC metro", "Dallas-Fort Worth
  metroplex", "Charleston, SC metro" and "Charleston area" all work. With
  several matches, the state, then metropolitan over micropolitan, then the
  title's first city decide.

Informal regions live in `geo/regions.mjs` with their aliases and a written
definition. Spelling variants are folded together before lookup:
North/Northern, N./Northern, South/Southern, Mid West/Midwest, North
East/Northeast, Mid-Atlantic/Mid Atlantic/Middle Atlantic, So Cal/SoCal,
Nor Cal/NorCal, No VA/NoVA.

### Defaults that need product approval

Informal boundaries vary, so each default below was chosen and documented.
Product should confirm or change each one.

| Region | Aliases | Default membership | Common alternatives |
|---|---|---|---|
| Northern Virginia | NoVA, North Virginia | NVRC jurisdictions: Arlington, Fairfax and Loudoun counties, Prince William County; Alexandria, Fairfax, Falls Church, Manassas and Manassas Park cities | + Stafford, Fauquier |
| DMV | the DMV | Washington-Arlington-Alexandria metro area (CBSA 47900) | all of DC + MD + VA |
| Southern Maryland | SoMD | Calvert, Charles and St. Mary's counties | |
| Southern California | SoCal, South California | Imperial, Kern, Los Angeles, Orange, Riverside, San Bernardino, San Diego, San Luis Obispo, Santa Barbara and Ventura counties | without Kern / SLO / Santa Barbara |
| Northern California | NorCal, North California | All other 48 CA counties (no overlap with SoCal) | excluding the Central Valley / Central Coast |
| Bay Area | SF Bay Area | ABAG's 9 counties | + Santa Cruz, San Benito |
| Inland Empire | | Riverside-San Bernardino-Ontario metro | |
| Mid-Atlantic | Mid Atlantic, Middle Atlantic | NY, NJ, PA, DE, MD, DC, VA, WV | Census Middle Atlantic division (NY, NJ, PA), available as "Middle Atlantic division" |
| East Coast | Eastern Seaboard, Atlantic Coast | the 14 Atlantic-coast states + DC + PA | + VT, WV |
| West Coast | Pacific Coast | CA, OR, WA | + AK, HI |
| Pacific Northwest | PNW | WA, OR, ID | WA, OR only |
| Southeast | | AL, FL, GA, MS, NC, SC, TN | + KY, VA, AR, LA |
| Southwest | | AZ, NM, TX, OK | + NV, UT, CO |
| Hampton Roads | Tidewater | Virginia Beach-Chesapeake-Norfolk metro | |
| Twin Cities | | Minneapolis-St. Paul-Bloomington metro | |
| South Florida | SoFlo | Miami-Fort Lauderdale-West Palm Beach metro | + Monroe County |
| Research Triangle | the Triangle | Raleigh-Durham-Cary combined area | |

Other interpretation choices to confirm:

- "Charleston area" and "Charleston, SC and surrounding areas" expand to the
  OMB metro area named after the city. If no metro area is named after it
  ("Silver Spring area"), the entry expands to the place's county.
- A bare "New York" is the state. Callers who mean the city say "New York
  City" or a borough. Brooklyn, Queens, Manhattan, the Bronx and Staten
  Island are recognized as their counties.

### Maintaining regions

- **Add or change an alias or definition:** edit `geo/regions.mjs`, bump
  `REGION_REGISTRY_VERSION`, and run `node --test` in `lambda/tools`. Loading
  fails with a clear error if two regions claim the same normalized alias or a
  county/CBSA code doesn't exist in the dataset.
- **Override or extend without editing the defaults:**
  `createResolver({ regionOverrides: [...] })` (or `createRegionRegistry`)
  merges by `id`. A matching id replaces the given fields and adds aliases.
  A new id adds a region. This is the hook for a later per-business setting
  such as "include Stafford in Northern Virginia". It is not wired to the UI
  yet.
- **Preview:** `describeServiceAreas({ serviceAreas, businessAddress })` returns
  what each configured entry was understood to be. That covers its kind
  (state / county / metro / region / place / zip / unrecognized), whether it
  was ambiguous, and the states, counties, places and ZIPs it includes. A
  wizard preview can be built on it later.

## Refreshing the dataset

Do this about once a year, when Census publishes a new Gazetteer (usually
late summer) or when OMB issues a new CBSA delineation bulletin:

1. In `scripts/build-service-area-geo.mjs`, update `GAZETTEER_YEAR` and, if
   OMB published one, the delineation URL.
2. `node scripts/build-service-area-geo.mjs --version <year>.1`. It
   downloads to a cache under the OS temp directory; `--cache <dir>` reuses
   one.
3. Review `manifest.json` counts against the previous version. Large swings
   mean a format change, not new geography.
4. Run `node --test` in `lambda/tools`. The registry check catches any
   county or CBSA code that changed (as Connecticut's did in 2022).
5. Deploy the tools Lambda. Agents need no republish, because their tool
   definitions only carry the configured entries.
