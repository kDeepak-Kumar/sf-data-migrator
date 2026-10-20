// User-configurable traversal and extraction rules.

export interface ChildRule {
  parentObject: string;
  childObject: string;
  field: string; // lookup field on the child that points at the parent
  relationshipName?: string | null;
  maxPerParent?: number;
}

export interface DiscoveryRules {
  maxDepth: number;
  maxRecords: number;
  followLookups: boolean;
  followMasterDetail: boolean;
  followPolymorphic: boolean;
  /** Empty = all objects permitted. */
  includeObjects: string[];
  excludeObjects: string[];
  /** Entries as `Object.Field` or `*.Field`. */
  excludeFields: string[];
  childRules: ChildRule[];
  /** 'writable' fetches createable/updateable fields plus Name; 'all' fetches every readable field. */
  fieldMode: 'writable' | 'all';
}

/** Setup and system objects: never copied. User, Group and RecordType are matched in the destination instead. */
export const REFERENCE_DATA_OBJECTS = ['User', 'Group', 'RecordType'];

export const DEFAULT_EXCLUDED_OBJECTS = [
  'Organization', 'Profile', 'UserRole', 'PermissionSet', 'PermissionSetAssignment', 'UserLicense', 'BusinessHours',
  'Network', 'Site', 'Folder', 'EmailTemplate', 'Document', 'BrandTemplate', 'CallCenter', 'ContentDocument',
  'ContentVersion', 'ContentAsset', 'CollaborationGroup', 'Territory', 'Territory2', 'Calendar', 'ProcessDefinition',
  'ProcessInstance', 'Community', 'Pricebook2', 'DandBCompany', 'Individual', 'OperatingHours', 'UserAppInfo',
];

export function defaultRules(): DiscoveryRules {
  return {
    maxDepth: 3,
    maxRecords: 2000,
    followLookups: true,
    followMasterDetail: true,
    followPolymorphic: true,
    includeObjects: [],
    excludeObjects: [...DEFAULT_EXCLUDED_OBJECTS],
    excludeFields: ['*.CreatedById', '*.LastModifiedById', '*.MasterRecordId'],
    childRules: [],
    fieldMode: 'writable',
  };
}

export const HARD_LIMITS = { maxDepth: 10, maxRecords: 50000 };

export function validateRules(r: DiscoveryRules): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(r.maxDepth) || r.maxDepth < 0 || r.maxDepth > HARD_LIMITS.maxDepth) errs.push(`Max depth must be 0–${HARD_LIMITS.maxDepth}.`);
  if (!Number.isInteger(r.maxRecords) || r.maxRecords < 1 || r.maxRecords > HARD_LIMITS.maxRecords) errs.push(`Max records must be 1–${HARD_LIMITS.maxRecords}.`);
  return errs;
}

const lc = (s: string) => s.toLowerCase();

export function isObjectExcluded(r: DiscoveryRules, object: string): boolean {
  if (r.excludeObjects.some((o) => lc(o) === lc(object))) return true;
  if (r.includeObjects.length && !r.includeObjects.some((o) => lc(o) === lc(object))) return true;
  return false;
}

export function isFieldExcluded(r: DiscoveryRules, object: string, field: string): boolean {
  return r.excludeFields.some((e) => {
    const [o, f] = e.includes('.') ? e.split('.') : ['*', e];
    return (o === '*' || lc(o) === lc(object)) && lc(f) === lc(field);
  });
}

export function isReferenceData(object: string): boolean {
  return REFERENCE_DATA_OBJECTS.some((o) => lc(o) === lc(object));
}
