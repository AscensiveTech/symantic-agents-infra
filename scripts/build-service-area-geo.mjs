#!/usr/bin/env node
// Builds the service-area geography dataset the tools Lambda resolves caller
// locations against (lambda/tools/geo/data/). Run it by hand, roughly once a
// year or whenever Census publishes a new Gazetteer or OMB a new CBSA
// delineation - see docs/service-area-geography.md for the refresh steps.
//
//   node scripts/build-service-area-geo.mjs [--cache <dir>] [--version <x>]
//
// Every source is an official Census Bureau / OMB file. Downloads are
// cached in --cache (default: <os tmpdir>/service-area-geo-sources), so a rebuild after a code
// change needs no network. The output is deterministic for the same inputs,
// so an unchanged rebuild produces no diff.
//
// Needs `unzip` on PATH (Gazetteer files are zipped, the CBSA list is .xlsx).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { STATE_BY_FIPS } from "../lambda/tools/geo/states.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "lambda/tools/geo/data");
const DATASET_FILE = "us-geo.txt.gz";

const GAZETTEER_YEAR = "2026";
const GAZ = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${GAZETTEER_YEAR}_Gazetteer`;
const SOURCES = {
  places: {
    url: `${GAZ}/${GAZETTEER_YEAR}_Gaz_place_national.zip`,
    member: `${GAZETTEER_YEAR}_Gaz_place_national.txt`,
    description: `Census ${GAZETTEER_YEAR} Gazetteer - places (incorporated places and CDPs)`,
  },
  counties: {
    url: `${GAZ}/${GAZETTEER_YEAR}_Gaz_counties_national.zip`,
    member: `${GAZETTEER_YEAR}_Gaz_counties_national.txt`,
    description: `Census ${GAZETTEER_YEAR} Gazetteer - counties and county equivalents (CT planning regions)`,
  },
  cousubs: {
    url: `${GAZ}/${GAZETTEER_YEAR}_Gaz_cousubs_national.zip`,
    member: `${GAZETTEER_YEAR}_Gaz_cousubs_national.txt`,
    description: `Census ${GAZETTEER_YEAR} Gazetteer - county subdivisions (towns and townships with an active government)`,
  },
  zctas: {
    url: `${GAZ}/${GAZETTEER_YEAR}_Gaz_zcta_national.zip`,
    member: `${GAZETTEER_YEAR}_Gaz_zcta_national.txt`,
    description: `Census ${GAZETTEER_YEAR} Gazetteer - ZIP Code Tabulation Areas (2020 ZCTA5)`,
  },
  placeByCounty: {
    url: "https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt",
    description: "Census 2020 place-by-county reference file",
  },
  zctaCounty: {
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
    description: "Census 2020 ZCTA-to-county relationship file",
  },
  zctaPlace: {
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt",
    description: "Census 2020 ZCTA-to-place relationship file",
  },
  ctZctaCousub: {
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2022/acs22_cousub22_zcta520_st09.txt",
    description: "Census 2022 Connecticut county-subdivision-to-ZCTA relationship file (planning regions)",
  },
  cbsa: {
    url: "https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx",
    description: "OMB Bulletin 23-01 (July 2023) CBSA and CSA delineation, Census list 1",
  },
};

const args = parseArgs(process.argv.slice(2));
const CACHE = resolve(args.cache ?? join(tmpdir(), "service-area-geo-sources"));
const DATASET_VERSION = args.version ?? `${GAZETTEER_YEAR}.1`;

mkdirSync(CACHE, { recursive: true });
const raw = {};
for (const [key, source] of Object.entries(SOURCES)) raw[key] = fetchSource(source);

// Connecticut replaced its 8 counties with 9 planning regions as county
// equivalents in 2022; the 2023 CBSA delineation and the current Gazetteer
// use the planning regions, while the 2020 relationship files still use the
// old counties. Everything CT is therefore re-keyed to planning regions.
const CT = "09";

// --- counties ---------------------------------------------------------------
const counties = new Map(); // geoid5 -> name
for (const row of table(text(raw.counties))) {
  if (!inScope(row.GEOID.slice(0, 2))) continue;
  counties.set(row.GEOID, row.NAME);
}

// --- ZCTAs -------------------------------------------------------------------
const zctaIds = new Set();
const zctaPoint = new Map();
for (const row of table(text(raw.zctas))) {
  zctaIds.add(row.GEOID);
  zctaPoint.set(row.GEOID, [Number(row.INTPTLAT), Number(row.INTPTLONG)]);
}

// zcta -> Map(county -> land area in that county)
const zctaCountyArea = new Map();
const addZctaCounty = (zcta, county, land, water) => {
  if (!zctaIds.has(zcta) || !counties.has(county)) return;
  const byCounty = zctaCountyArea.get(zcta) ?? new Map();
  byCounty.set(county, (byCounty.get(county) ?? 0) + (land || water / 1000));
  zctaCountyArea.set(zcta, byCounty);
};
for (const row of table(text(raw.zctaCounty))) {
  if (!row.GEOID_ZCTA5_20 || row.GEOID_COUNTY_20.startsWith(CT)) continue;
  addZctaCounty(row.GEOID_ZCTA5_20, row.GEOID_COUNTY_20, Number(row.AREALAND_PART), Number(row.AREAWATER_PART));
}
for (const row of table(text(raw.ctZctaCousub))) {
  if (!row.GEOID_ZCTA5_20) continue;
  addZctaCounty(row.GEOID_ZCTA5_20, row.GEOID_COUSUB_22.slice(0, 5), Number(row.AREALAND_PART), Number(row.AREAWATER_PART));
}
// A ZCTA's counties, largest share first; slivers under 10% are dropped.
const zctaCounties = new Map();
for (const [zcta, byCounty] of zctaCountyArea) {
  const total = [...byCounty.values()].reduce((sum, area) => sum + area, 0) || 1;
  const ranked = [...byCounty].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  zctaCounties.set(zcta, ranked.filter(([, area], index) => index === 0 || area / total >= 0.1).map(([county]) => county));
}

// --- places ------------------------------------------------------------------
const placeCounties = new Map(); // state+place fips -> Set(county geoid)
for (const row of table(text(raw.placeByCounty))) {
  if (row.STATEFP === CT || !inScope(row.STATEFP)) continue;
  const key = row.STATEFP + row.PLACEFP;
  const set = placeCounties.get(key) ?? new Set();
  set.add(row.STATEFP + row.COUNTYFP);
  placeCounties.set(key, set);
}

// ZCTA <-> place overlaps: CT place counties (via ZCTA planning regions) and
// the place name each ZCTA is best known by.
const zctaPlaceArea = new Map(); // zcta -> [placeGeoid, land]
const ctPlaceRegionArea = new Map(); // CT place -> Map(region -> weighted land)
const place2020Names = new Map();
for (const row of table(text(raw.zctaPlace))) {
  const zcta = row.GEOID_ZCTA5_20;
  const place = row.GEOID_PLACE_20;
  if (!zcta || !place || !zctaIds.has(zcta)) continue;
  const land = Number(row.AREALAND_PART);
  place2020Names.set(place, row.NAMELSAD_PLACE_20);
  const zctaLand = Number(row.AREALAND_ZCTA5_20) || 1;
  const best = zctaPlaceArea.get(zcta);
  if (land / zctaLand >= 0.2 && (!best || land > best[1])) zctaPlaceArea.set(zcta, [place, land]);
  if (place.startsWith(CT)) {
    const regions = ctPlaceRegionArea.get(place) ?? new Map();
    const zctaRegions = zctaCountyArea.get(zcta) ?? new Map();
    const zctaTotal = [...zctaRegions.values()].reduce((sum, area) => sum + area, 0) || 1;
    for (const [region, area] of zctaRegions) regions.set(region, (regions.get(region) ?? 0) + land * (area / zctaTotal));
    ctPlaceRegionArea.set(place, regions);
  }
}
for (const [place, regions] of ctPlaceRegionArea) {
  const total = [...regions.values()].reduce((sum, area) => sum + area, 0) || 1;
  const ranked = [...regions].sort((a, b) => b[1] - a[1]);
  placeCounties.set(place, new Set(ranked.filter(([, area], index) => index === 0 || area / total >= 0.1).map(([region]) => region)));
}

const placeRows = [];
const placeDisplay = new Map(); // place geoid -> display name
let placesWithoutCounty = 0;
const placesByState = new Map(); // state -> Set(normalized name|county) for cousub de-duplication
for (const row of table(text(raw.places))) {
  const state = row.GEOID.slice(0, 2);
  if (!inScope(state)) continue;
  const { name, aliases } = placeName(row.NAME);
  if (!name) continue;
  placeDisplay.set(row.GEOID, name);
  let countySet = placeCounties.get(row.GEOID);
  if (!countySet?.size) {
    // Created or recoded since 2020: take the county of the nearest ZCTA
    // interior point in the same state.
    const nearest = nearestZcta(state, Number(row.INTPTLAT), Number(row.INTPTLONG));
    countySet = new Set(nearest ? [zctaCounties.get(nearest)[0]] : []);
    placesWithoutCounty += 1;
  }
  const countyList = [...countySet].filter((county) => counties.has(county)).sort();
  placeRows.push(["P", state, name, countyList.map((county) => county.slice(2)).join(" "), "p", aliases.join(";")]);
  const seen = placesByState.get(state) ?? new Set();
  for (const county of countyList) seen.add(`${dedupeKey(name)}|${county}`);
  placesByState.set(state, seen);
}

// Towns and townships with an active government (New England towns, NY
// towns, NJ/PA/MI/OH/... townships) - real places callers name that are
// county subdivisions rather than Census places.
let townRows = 0;
for (const row of table(text(raw.cousubs))) {
  const state = row.GEOID.slice(0, 2);
  if (!inScope(state) || !["A", "B", "C"].includes(row.FUNCSTAT)) continue;
  const match = row.NAME.match(/^(.*?) (charter township|township|town|plantation)$/);
  if (!match || /\d/.test(match[1])) continue;
  const county = row.GEOID.slice(0, 5);
  if (!counties.has(county)) continue;
  if (placesByState.get(state)?.has(`${dedupeKey(match[1])}|${county}`)) continue;
  placeRows.push(["P", state, match[1], county.slice(2), "t", ""]);
  townRows += 1;
}

// --- CBSAs and CSAs (OMB July 2023) -------------------------------------------
const cbsas = new Map(); // code -> { kind, csa, title, counties: Set }
const csas = new Map(); // code -> title
for (const row of readXlsxRows(raw.cbsa)) {
  const [code, , csa, title, kind, , csaTitle, , , stateFips, countyFips] = row;
  if (!/^\d{5}$/.test(code ?? "") || !inScope(stateFips)) continue;
  const county = stateFips + countyFips;
  if (!counties.has(county)) throw new Error(`CBSA ${code} references unknown county ${county}`);
  const entry = cbsas.get(code) ?? {
    kind: kind.startsWith("Metropolitan") ? "M" : "m",
    csa: csa || "",
    title,
    counties: new Set(),
  };
  entry.counties.add(county);
  cbsas.set(code, entry);
  if (csa) csas.set(csa, csaTitle);
}

// --- ZIP rows -------------------------------------------------------------------
const zipRows = [];
for (const zcta of [...zctaIds].sort()) {
  const zctaCountyList = zctaCounties.get(zcta);
  if (!zctaCountyList?.length) continue; // territories, or no in-scope county
  const place = zctaPlaceArea.get(zcta)?.[0];
  const name = place ? placeDisplay.get(place) ?? placeName(place2020Names.get(place) ?? "").name : "";
  zipRows.push(["Z", zcta, zctaCountyList.join(" "), name]);
}

// --- write --------------------------------------------------------------------------
const lines = [
  `#service-area-geo ${DATASET_VERSION}`,
  ...[...counties].sort().map(([geoid, name]) => ["C", geoid, name].join("|")),
  ...[...csas].sort().map(([code, title]) => ["S", code, title].join("|")),
  ...[...cbsas].sort().map(([code, cbsa]) =>
    ["B", code, cbsa.kind, cbsa.csa, cbsa.title, [...cbsa.counties].sort().join(" ")].join("|")),
  ...placeRows.sort(compareRows).map((row) => row.join("|")),
  ...zipRows.map((row) => row.join("|")),
];
for (const line of lines) {
  if (line.split("|").some((field) => field.includes("\n"))) throw new Error(`bad row: ${line}`);
}
const body = `${lines.join("\n")}\n`;
const gz = gzipSync(Buffer.from(body, "utf8"), { level: 9 });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, DATASET_FILE), gz);

const manifest = {
  datasetVersion: DATASET_VERSION,
  file: DATASET_FILE,
  sha256: sha256(gz),
  uncompressedBytes: Buffer.byteLength(body),
  counts: {
    counties: counties.size,
    cbsas: cbsas.size,
    metropolitanAreas: [...cbsas.values()].filter((cbsa) => cbsa.kind === "M").length,
    csas: csas.size,
    places: placeRows.length - townRows,
    towns: townRows,
    placesWithCountyFromNearestZcta: placesWithoutCounty,
    zips: zipRows.length,
  },
  sources: Object.entries(SOURCES).map(([key, source]) => ({
    key,
    description: source.description,
    url: source.url,
    sha256: sha256(raw[key].downloaded),
  })),
};
writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ version: DATASET_VERSION, bytes: gz.length, ...manifest.counts }, null, 2));

// --- helpers ------------------------------------------------------------------------

function parseArgs(list) {
  const parsed = {};
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "--cache") parsed.cache = list[++i];
    else if (list[i] === "--version") parsed.version = list[++i];
    else throw new Error(`unknown argument ${list[i]}`);
  }
  return parsed;
}

function fetchSource(source) {
  const file = join(CACHE, source.url.split("/").pop());
  if (!existsSync(file)) {
    console.error(`downloading ${source.url}`);
    execFileSync("curl", ["-sSfL", "--retry", "3", "-o", file, source.url], { stdio: "inherit" });
  }
  const downloaded = readFileSync(file);
  const content = source.member ? execFileSync("unzip", ["-p", file, source.member], { maxBuffer: 1 << 30 }) : downloaded;
  return { downloaded, content, file };
}

function text(source) {
  return source.content.toString("utf8").replace(/^﻿/, "");
}

// Pipe-delimited Census text with a header row -> objects. Headers can
// carry a trailing "(INCITS..)" note or stray whitespace.
function table(content) {
  const [header, ...rows] = content.split(/\r?\n/).filter(Boolean);
  const keys = header.split("|").map((key) => key.trim());
  return rows.map((line) => {
    const values = line.split("|");
    return Object.fromEntries(keys.map((key, index) => [key, (values[index] ?? "").trim()]));
  });
}

function inScope(stateFips) {
  return STATE_BY_FIPS.has(stateFips);
}

// "Silver Spring CDP" -> "Silver Spring"; consolidated governments keep the
// name callers use as an alias ("Nashville-Davidson metropolitan government
// (balance)" -> "Nashville-Davidson", alias "Nashville").
function placeName(raw) {
  let name = raw.trim();
  const aliases = [];
  const consolidated = /\(balance\)|government|urban county/.test(name);
  name = name.replace(/\s*\(balance\)$/, "")
    .replace(/ (metropolitan government|metro government|unified government|consolidated government|urban county)$/, "")
    .replace(/ (city and borough|city|town|village|borough|CDP|municipality|corporation|comunidad|zona urbana)$/, "");
  const parenthetical = name.match(/^(.*?) \((.+)\)$/);
  if (parenthetical) {
    name = parenthetical[1];
    aliases.push(parenthetical[2]);
  }
  if (consolidated && /[-/]/.test(name)) aliases.push(name.split(/[-/]/)[0].trim());
  if (/^Urban /.test(name)) aliases.push(name.replace(/^Urban /, ""));
  return { name, aliases: aliases.filter((alias) => alias && alias !== name) };
}

function dedupeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nearestZcta(state, lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  for (const [zcta, list] of zctaCounties) {
    if (!list[0].startsWith(state)) continue;
    const [zLat, zLon] = zctaPoint.get(zcta);
    const distance = (zLat - lat) ** 2 + ((zLon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = zcta;
    }
  }
  return best;
}

function compareRows(a, b) {
  return a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]) || a[4].localeCompare(b[4]);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Minimal .xlsx reader for the single-sheet OMB delineation workbook:
// shared strings plus <c r="A12" t="s"><v>..</v></c> cells, returned as
// arrays indexed by column (A = 0).
function readXlsxRows(source) {
  const unzipMember = (member) => execFileSync("unzip", ["-p", source.file, member], { maxBuffer: 1 << 30 }).toString("utf8");
  const decode = (value) => value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const strings = [...unzipMember("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(([, si]) => decode([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join("")));
  const rows = [];
  for (const [, rowXml] of unzipMember("xl/worksheets/sheet1.xml").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const [, attrs, inner] of rowXml.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attrs.match(/r="([A-Z]+)\d+"/)[1];
      const column = [...ref].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const value = inner?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? inner?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      if (value === undefined) continue;
      row[column] = /t="s"/.test(attrs) ? strings[Number(value)] : decode(value);
    }
    rows.push(row.map((cell) => (cell ?? "").trim()));
  }
  return rows;
}
