// Amazon Location Geocode result items, shaped like the real responses
// (captured from the live API for these places on 2026-10-11).

export function item({
  type = "Locality",
  title,
  country = ["USA", "US", "United States"],
  region = null,
  subRegion = null,
  locality = null,
  district = null,
  postalCode = null,
  position = null,
  mapView = null,
  score = 1,
  placeId = null,
}) {
  return {
    PlaceId: placeId ?? `id-${title}`,
    PlaceType: type,
    Title: title,
    Address: {
      Label: title,
      Country: { Code3: country[0], Code2: country[1], Name: country[2] },
      ...(region ? { Region: { Code: region[0], Name: region[1] } } : {}),
      ...(subRegion ? { SubRegion: { Name: subRegion } } : {}),
      ...(locality ? { Locality: locality } : {}),
      ...(district ? { District: district } : {}),
      ...(postalCode ? { PostalCode: postalCode } : {}),
    },
    ...(position ? { Position: position } : {}),
    ...(mapView ? { MapView: mapView } : {}),
    MatchScores: { Overall: score },
  };
}

const MD = ["MD", "Maryland"];
const VA = ["VA", "Virginia"];

export const PLACES = {
  silverSpringMd: item({ title: "Silver Spring, MD, United States", region: MD, subRegion: "Montgomery", locality: "Silver Spring", postalCode: "20910", position: [-77.02595, 38.99062], mapView: [-77.0934, 38.98303, -76.92905, 39.14691] }),
  silverSpringPa: item({ title: "Silver Spring Twp, PA, United States", region: ["PA", "Pennsylvania"], subRegion: "Cumberland", locality: "Silver Spring Twp", position: [-77.0566, 40.2498], mapView: [-77.10854, 40.19486, -77.00471, 40.30481] }),
  zip20910: item({ type: "PostalCode", title: "20910, Silver Spring, MD, United States", region: MD, subRegion: "Montgomery", locality: "Silver Spring", postalCode: "20910", position: [-77.0347, 39.0019], mapView: [-77.06646, 38.98265, -77.00374, 39.02448] }),
  zip20910plus4: item({ type: "PointAddress", title: "8401 Colesville Rd, Silver Spring, MD 20910-6331, United States", region: MD, subRegion: "Montgomery", locality: "Silver Spring", postalCode: "20910-6331", position: [-77.0302, 38.9973] }),
  montgomeryCounty: item({ type: "SubRegion", title: "Montgomery, MD, United States", region: MD, subRegion: "Montgomery", position: [-77.2, 39.14], mapView: [-77.52745, 38.93443, -76.88783, 39.35414] }),
  maryland: item({ type: "Region", title: "Maryland, United States", region: MD, position: [-76.64, 39.05], mapView: [-79.487651, 37.886605, -75.04894, 39.723037] }),
  arlingtonVa: item({ title: "Arlington, VA, United States", region: VA, subRegion: "Arlington", locality: "Arlington", position: [-77.10428, 38.88101], mapView: [-77.17189, 38.82739, -77.03235, 38.93172] }),
  arlingtonTx: item({ title: "Arlington, TX, United States", region: ["TX", "Texas"], subRegion: "Tarrant", locality: "Arlington", position: [-97.10807, 32.73569], mapView: [-97.23, 32.58, -97.03, 32.82] }),
  baltimore: item({ title: "Baltimore, MD, United States", region: MD, subRegion: "Baltimore (City)", locality: "Baltimore", position: [-76.61219, 39.29038], mapView: [-76.71151, 39.19721, -76.52945, 39.37221] }),
  morgantownWv: item({ title: "Morgantown, WV, United States", region: ["WV", "West Virginia"], subRegion: "Monongalia", locality: "Morgantown", position: [-79.95589, 39.62953], mapView: [-80.0, 39.6, -79.9, 39.67] }),
  richmondVa: item({ title: "Richmond, VA, United States", region: VA, subRegion: "Richmond (City)", locality: "Richmond", position: [-77.43605, 37.54072], mapView: [-77.6, 37.45, -77.38, 37.6] }),
  bloomvilleNy: item({ title: "Bloomville, NY, United States", region: ["NY", "New York"], subRegion: "Delaware", locality: "Bloomville", position: [-74.81, 42.33], mapView: [-74.85241, 42.3072, -74.72867, 42.44061], score: 0.8 }),
  northernConcrete: item({ type: "PointOfInterest", title: "Northern Concrete", region: VA, subRegion: "Fairfax", locality: "Fairfax", position: [-77.3, 38.85], score: 0.95 }),
  manchesterM1: item({ type: "PostalCode", title: "M1 1AE, Manchester, England, United Kingdom", country: ["GBR", "GB", "United Kingdom"], region: ["ENG", "England"], subRegion: "Greater Manchester", locality: "Manchester", postalCode: "M1 1AE", position: [-2.2374, 53.4794], mapView: [-2.239, 53.478, -2.236, 53.481] }),
  salfordM5: item({ type: "PostalCode", title: "M5 4WT, Salford, England, United Kingdom", country: ["GBR", "GB", "United Kingdom"], region: ["ENG", "England"], subRegion: "Greater Manchester", locality: "Salford", postalCode: "M5 4WT", position: [-2.2756, 53.4831] }),
  bengaluru: item({ title: "Bengaluru, Karnataka, India", country: ["IND", "IN", "India"], region: ["KA", "Karnataka"], subRegion: "Bengaluru Urban", locality: "Bengaluru", postalCode: "560002", position: [77.59369, 12.97194], mapView: [77.37, 12.83, 77.78, 13.14] }),
  mysuru: item({ title: "Mysuru, Karnataka, India", country: ["IND", "IN", "India"], region: ["KA", "Karnataka"], subRegion: "Mysuru", locality: "Mysuru", position: [76.6394, 12.2958], mapView: [76.58, 12.24, 76.71, 12.36] }),
  parisDistrict: item({ type: "District", title: "Le Marais, Paris, Île-de-France, France", country: ["FRA", "FR", "France"], region: ["IDF", "Île-de-France"], subRegion: "Paris", locality: "Paris", district: "Le Marais", postalCode: "75004", position: [2.3622, 48.8575] }),
  lyon: item({ title: "Lyon, Auvergne-Rhône-Alpes, France", country: ["FRA", "FR", "France"], region: ["ARA", "Auvergne-Rhône-Alpes"], subRegion: "Rhône", locality: "Lyon", position: [4.8357, 45.764], mapView: [4.77, 45.70, 4.9, 45.81] }),
};

// Zones as the Service Area editor saves them.
export const ZONES = {
  maryland: { id: "md", type: "place", label: "Maryland", place: { placeType: "Region", countryCode: "USA", regionCode: "MD", regionName: "Maryland" }, position: [-76.64, 39.05], mapView: [-79.487651, 37.886605, -75.04894, 39.723037] },
  montgomeryCounty: { id: "mc", type: "place", label: "Montgomery County, MD", place: { placeType: "SubRegion", countryCode: "USA", regionCode: "MD", regionName: "Maryland", subRegionName: "Montgomery" }, position: [-77.2, 39.14], mapView: [-77.52745, 38.93443, -76.88783, 39.35414] },
  silverSpring: { id: "ss", type: "place", label: "Silver Spring, MD", place: { placeType: "Locality", countryCode: "USA", regionCode: "MD", regionName: "Maryland", subRegionName: "Montgomery", locality: "Silver Spring" }, position: [-77.02595, 38.99062], mapView: [-77.0934, 38.98303, -76.92905, 39.14691] },
  zip20910: { id: "z", type: "place", label: "20910", place: { placeType: "PostalCode", countryCode: "USA", regionCode: "MD", postalCode: "20910", locality: "Silver Spring" }, position: [-77.0347, 39.0019] },
  virginia: { id: "va", type: "place", label: "Virginia", place: { placeType: "Region", countryCode: "USA", regionCode: "VA", regionName: "Virginia" } },
  usa: { id: "us", type: "place", label: "United States", place: { placeType: "Country", countryCode: "USA", countryName: "United States" } },
  // A rough outline around Arlington, Alexandria and Fairfax.
  northernVirginia: { id: "nova", type: "polygon", label: "Northern Virginia", coordinates: [[-77.55, 38.6], [-77.0, 38.6], [-77.0, 39.05], [-77.55, 39.05]], area: { countryCode: "USA", regionCode: "VA", regionName: "Virginia" } },
  // 25 km around downtown Silver Spring.
  radiusSilverSpring: { id: "r", type: "radius", label: "Silver Spring", center: [-77.02595, 38.99062], radiusMeters: 25000, unit: "km", area: { countryCode: "USA", regionCode: "MD", regionName: "Maryland" } },
  manchesterM1: { id: "m1", type: "place", label: "M1, Manchester", place: { placeType: "PostalCode", countryCode: "GBR", regionCode: "ENG", postalCode: "M1", locality: "Manchester" } },
  bengaluru: { id: "blr", type: "place", label: "Bengaluru", place: { placeType: "Locality", countryCode: "IND", regionCode: "KA", regionName: "Karnataka", subRegionName: "Bengaluru Urban", locality: "Bengaluru" } },
  paris: { id: "paris", type: "place", label: "Paris", place: { placeType: "Locality", countryCode: "FRA", regionCode: "IDF", regionName: "Île-de-France", subRegionName: "Paris", locality: "Paris" } },
};
