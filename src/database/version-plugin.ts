import type { Schema } from 'mongoose';

/**
 * Reusable Mongoose plugin adding an authoritative numeric version field.
 * Default is 1; automatically incremented on each mutation in the active transaction.
 * Guarantees that documents without version are treated as version 1, and that
 * version cannot be incremented twice on a single write.
 */
export function versionPlugin(schema: Schema): void {
  if (!schema.path('version')) {
    schema.add({ version: { type: Number, default: 1, required: true } });
  }

  // Existing documents in database without a version field are treated as version 1
  schema.post('init', function (this: any) {
    if (this.version === undefined || this.version === null) {
      this.version = 1;
    }
  });

  schema.pre(['updateOne', 'findOneAndUpdate'], function (this: any) {
    const update = this.getUpdate();
    if (!update) return;
    // Don't duplicate if explicit version set/inc was supplied
    if (update.$inc && update.$inc.version !== undefined) return;
    if (update.$set && update.$set.version !== undefined) return;
    if (!update.$inc) update.$inc = {};
    update.$inc.version = 1;
  });

  schema.pre('save', function (this: any) {
    if (!this.isNew) {
      // Skip saves that changed nothing
      if (typeof this.isModified === 'function' && !this.isModified()) {
        return;
      }
      if (typeof this.directModifiedPaths === 'function') {
        const modified = this.directModifiedPaths();
        if (modified.length === 0 || (modified.length === 1 && modified[0] === 'version')) {
          return;
        }
      }
      // Guard against double increment on a single write operation
      if (!this.$locals?.__versionIncremented) {
        this.version = (this.version || 1) + 1;
        if (!this.$locals) this.$locals = {};
        this.$locals.__versionIncremented = true;
      }
    } else {
      if (!this.version) this.version = 1;
    }
  });

  schema.post('save', function (this: any) {
    if (this.$locals) {
      this.$locals.__versionIncremented = false;
    }
  });
}
