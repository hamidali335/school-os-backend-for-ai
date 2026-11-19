import { useTestApp } from './helpers';
import { laneSuite } from './import-lanes-suite';

/** Lanes on a standalone server (no transactions: each row's own undo applies). */
laneSuite(useTestApp());
