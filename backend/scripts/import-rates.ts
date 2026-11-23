// npm run rates:import  -> rate workbooks in RATES_DIR become the active rate group
// npm run geo:import    -> downloads Census + GeoNames ZIP data into us_location_master
import { pool } from '../src/db/pool.js';
import { importGeo } from '../src/services/rating/geoImport.js';
import { importRates } from '../src/services/rating/importer.js';

const what = process.argv[2];
const run =
  what === 'geo'
    ? importGeo()
    : what === 'rates'
      ? importRates()
      : Promise.reject(new Error('Usage: import-rates.ts rates|geo'));
run
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
