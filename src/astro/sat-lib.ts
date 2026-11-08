// Pulls only the parts of satellite.js this app uses. Importing the package root also drags in
// its WebAssembly bulk propagator (300 KB we don't need), and the package exposes no subpaths.
export { json2satrec } from '../../node_modules/satellite.js/dist/io.js';
export { propagate, gstime } from '../../node_modules/satellite.js/dist/propagation.js';
export { eciToEcf, ecfToLookAngles, geodeticToEcf, ecfToEci, degreesToRadians } from '../../node_modules/satellite.js/dist/transforms.js';
export { sunPos } from '../../node_modules/satellite.js/dist/sun.js';
export { jday } from '../../node_modules/satellite.js/dist/ext.js';
export { shadowFraction } from '../../node_modules/satellite.js/dist/shadow.js';
export type { SatRec } from '../../node_modules/satellite.js/dist/propagation/SatRec.js';
export type { OMMJsonObject, GeodeticLocation } from '../../node_modules/satellite.js/dist/common-types.js';
