import { useTestApp } from './helpers';
import { laneSuite } from './import-lanes-suite';

/** Lanes on a replica set (each row in a transaction). */
laneSuite(useTestApp());
