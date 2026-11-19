import { paymentAllocationSuite } from './payment-allocation-suite';

// Standalone MongoDB: no transactions, so the per-invoice payment lock is what keeps payments apart.
paymentAllocationSuite();
