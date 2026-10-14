# Service areas

How a business defines where it serves, and how a call decides whether the
caller's location is covered. It works in any country.

Code:
- Frontend editor: `components/service-area-map.tsx` and `service-area-map-canvas.tsx` (the wizard's Business Profile step).
- BFF map search: `lambda/bff/geo.mjs`.
- Zone validation: `lambda/bff/voice-agent/service-zones.mjs`.
- Call-time check: `lambda/tools/geo/coverage.mjs`, called by `lambda/tools/handlers/service-area.mjs`.
- Infrastructure: `location.tf`.

## How other platforms do it, and what this copies

| Platform | How the area is defined | How a customer is checked |
|---|---|---|
| Google Business Profile | Up to 20 named areas from autocomplete (cities, postal codes, regions); no radius | display only |
| Housecall Pro, ServiceTitan | ZIP codes or cities per zone; the map is for viewing | customer's ZIP or city text |
| Thumbtack | Mile radius or an uploaded ZIP list | radius or ZIP |
| Toast, Owner.com, Shopify delivery apps, StoreKit, DoorDash self-delivery | Radius, postal codes, or a polygon drawn on a map (DoorDash takes a KML outline) | the address is geocoded, then point-in-shape |

The pattern across them is three kinds of zone. This product supports all three:

1. **Named places**, picked from search: country, state/province/region, county/district, city or town, neighbourhood, or postal code.
2. **Radius**: a circle in km or miles around an address or a point on the map.
3. **Drawn area**: an outline clicked onto the map.

No platform keeps its own per-country place database. The earlier US-only
Census dataset (`lambda/tools/geo/resolver.mjs`) was removed in favour of
this approach.

## Provider: Amazon Location Service

Chosen over Google Maps Platform because:
- **Storage is allowed.** Saved zones keep their address components
  permanently. Amazon Location allows this when a request is made with
  `IntendedUse: "Storage"`, charged at the Stored rate. Google's terms only
  allow place IDs to be kept long-term; coordinates must be deleted after
  30 days.
- **No new vendor.** It runs in the same AWS account, under the Lambdas' IAM
  roles, with no new vendor contract or billing account.
- **Worldwide coverage.** It returns country, region, sub-region (county),
  locality, district and postal code worldwide, and supports filtering by
  country and biasing toward a position.

Map data comes from HERE and Esri. Their attribution is shown on the map.

### Who calls what

| Caller | API | Stored? | Why |
|---|---|---|---|
| Browser (MapLibre) | map tiles, via a public API key | n/a | The key is limited to `geo-maps:GetTile`/`GetStaticMap` and this app's own pages (`location.tf`). |
| BFF `/workspaces/me/geo/search` | Suggest and Autocomplete | no | Typing in the search box. Suggest finds counties; Autocomplete is better at postal codes. The results are merged. |
| BFF `/workspaces/me/geo/place` | GetPlace | **Storage** | The address components saved on a zone. |
| BFF `/workspaces/me/geo/reverse` | ReverseGeocode | **Storage** | The country and region of a radius center or drawn area. |
| BFF `/workspaces/me/geo/config` | DescribeKey | n/a | Hands the browser the restricted maps key. |
| Tools Lambda (each check) | Geocode | no | The caller's words. Kept in memory for an hour per container. |

No places-capable key ever reaches the browser. The map key can only fetch
tiles, and only from this app's pages.

Cost: one Geocode per coverage check, plus the business address the first
time per container. A few lookups each time someone edits zones. Map tiles
while the editor is open. All are billed per request. See the AWS Location
pricing pages; volume discounts start at $5,000/month.

## Zones

Stored in the Business Profile as `serviceZones`, on the agent's own profile
(`configuration.businessProfile`) or the workspace profile:

```json
[
  { "id": "…", "type": "place", "label": "Montgomery, MD, United States",
    "place": { "placeId": "…", "placeType": "SubRegion", "countryCode": "USA", "countryName": "United States",
               "regionCode": "MD", "regionName": "Maryland", "subRegionName": "Montgomery",
               "locality": null, "district": null, "postalCode": null },
    "position": [-77.2, 39.14], "mapView": [-77.52, 38.93, -76.88, 39.35] },
  { "id": "…", "type": "radius", "label": "Myrtle Beach", "center": [-78.88, 33.69], "radiusMeters": 40000, "unit": "mi",
    "area": { "countryCode": "USA", "regionCode": "SC", "regionName": "South Carolina" } },
  { "id": "…", "type": "polygon", "label": "Northern Virginia", "coordinates": [[-77.5, 38.6], …],
    "area": { "countryCode": "USA", "regionCode": "VA", "regionName": "Virginia" } }
]
```

Limits: 50 zones, 250 points per outline, 2,000 points in total, and a
radius of 100 m to 500 km. They are enforced in the BFF; the editor stays
within them.

Zones are **not** put in the Retell tool definition. An outline can be
hundreds of points, which the model would read on every turn. The tools
Lambda reads them from the agent's **published** `configuration` at call
time, one DynamoDB read, as the transfer and booking tools already do. An
edit that hasn't been published (`pendingConfiguration`) doesn't affect
live calls.

## The coverage check

1. **Geocode the caller's words** with Amazon Location Geocode. The request is
   biased to the business address and limited to the countries the zones are
   in. Businesses and landmarks (`PointOfInterest`) are ignored. For example,
   "Northern Virginia" geocodes to companies with those words in their name.
2. **Accept a result** only with a match score of 0.9 or higher. Results within
   0.05 of the best are treated as the same question ("Silver Spring" returns
   both Maryland and Pennsylvania at 1.0).
3. **Check each result against each zone:**
   - **Named place:** match on address components. A result is inside the
     zone when every component that defines the zone matches: country, then
     region code, county, city, neighbourhood. A postal-code zone matches by
     prefix, so "SW1A" covers "SW1A 1AA" and "20910" covers "20910-1234". A
     result bigger than the zone, such as a state named against a city zone,
     is *partial*. No provider publishes the outline of a city or postal
     code, so components are the reliable test. This is also how Google
     Business Profile and field-service tools match.
   - **Radius and drawn area:** match on position. A street address or postal
     code is a point. For a town, all four corners of its bounding box inside
     the shape counts as covered, and so does its center being inside. For a
     county or region, the center alone is only partial.
4. **Decide:**
   - If every reading is covered, the result is `covered`.
   - If one reading is partial, the result is `ambiguous`, and the question
     asks for the postal code or the town.
   - If readings disagree and more than one is plausible, the result is
     `ambiguous`: "Which state or province is that in, or what's the postal
     code?" A reading is plausible when it is covered, partial, or in a
     region where the business works.
   - If none are plausible, the result is `outside`.
   - Nothing, or only weak matches, gives `unresolved`. The question is "Did
     you say …?" or a request to spell the town or give the postal code.
   - Agents serving only the US say "ZIP code" instead of "postal code".
5. **The business's own town and postal code** (from its address) are always covered.

The result contract is unchanged from before: `status`, `canonicalLocation`,
`matchedBy`, `matchedArea`, `confidence`, `message`, `clarificationQuestion`,
plus `ok`/`matched` for older agents. `matchedBy` is one of `postal_code`,
`place`, `region`, `radius`, `polygon` or `business_location`.

A Geocode failure (throttling, outage) is returned as a tool error. The
prompt then says the team will confirm coverage. It never guesses.

## Older text lists

Before zones, Exact Coverage was a text list (`serviceAreas`). When there are
no zones, coverage comes from that list, and those entries are geocoded at
call time. The retired What Callers Hear text (`serviceAreaSummary`) is never
read, for coverage or for what callers hear. When asked where the business
serves, the receptionist names the zones (a radius as "the area around" its
center, never its size; unnamed drawn areas are skipped) or the older list.
Entries that resolve to a real area are used as named places. Others, such as
"DC metro area", are kept as words: a caller saying exactly those words is
covered.

The editor lists these as **Earlier text entries**, each with a *Find on map*
button that replaces it with a real place. Once any zone exists, the text list
is ignored. Regional nicknames ("Northern Virginia", "the DMV", "SoCal") are
not places on the map, so they are added as their counties or drawn.

## What's not in this release

- Exclusions ("all of the county except one town").
- Outlines of named places on the map. The editor shows a named place as its
  approximate bounding box, drawn dashed.
- A per-zone travel fee or technician assignment.
