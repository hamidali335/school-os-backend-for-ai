/**
 * How attendance gets from a fingerprint machine into the system. Each method is an adapter;
 * the attendance logic (linking device users, de-duplicating punches, daily records) is shared
 * and never depends on the manufacturer.
 *
 * Only methods marked `implemented` work. The others are listed so schools and support staff see
 * what is planned and what it needs; they have no controls that pretend to connect. No adapter
 * claims a whole manufacturer: compatibility depends on the model and its firmware.
 */

export const INTEGRATION_METHODS = [
  'file_import',
  'connector_api',
  'zkteco_push',
  'zkteco_lan',
  'suprema_biostar2',
  'local_connector',
] as const;
export type IntegrationMethod = (typeof INTEGRATION_METHODS)[number];

export interface IntegrationInfo {
  method: IntegrationMethod;
  label: string;
  status: 'implemented' | 'planned';
  description: string;
  /** What a school does to use it (implemented) or what is needed to build it (planned). */
  steps: string[];
  /** Can a device registered with this method be used for attendance now? */
  usable: boolean;
}

export const INTEGRATIONS: Record<IntegrationMethod, IntegrationInfo> = {
  file_import: {
    method: 'file_import',
    label: 'File import (CSV, Excel, TXT)',
    status: 'implemented',
    usable: true,
    description:
      'Export the attendance log from the machine (or its software) and import the file. Works with any machine whose export has a user ID and a date and time for each punch.',
    steps: [
      'Export the attendance records from the machine or its PC software (USB flash drive or "Export" menu).',
      'Import data → Staff attendance punches: choose this device, upload the file and match the columns.',
      'Link each device user ID to a staff member (Staff attendance → Device users), check and import.',
    ],
  },
  connector_api: {
    method: 'connector_api',
    label: 'Connector API (for a local connector or middleware)',
    status: 'implemented',
    usable: true,
    description:
      'A program on the school’s network sends punches to this system over HTTPS with the device’s connector key. Nothing on the school network is opened to the internet. The program itself is not provided yet (see Local connector).',
    steps: [
      'Create a connector key for the device (shown once; store it in the connector’s settings).',
      'The connector sends POST /api/v1/biometric/ingest with the key as a Bearer token and up to 1,000 punches per request.',
      'Sending the same punches again is safe: each punch is stored once.',
    ],
  },
  zkteco_push: {
    method: 'zkteco_push',
    label: 'ZKTeco push (device sends to the cloud)',
    status: 'planned',
    usable: false,
    description:
      'Some ZKTeco models can push attendance to a server themselves when their firmware has the push/cloud server option. Not built yet.',
    steps: [
      'The exact model and firmware version of the school’s machines, and confirmation that their menu has the push/cloud server setting.',
      'ZKTeco’s official push protocol documentation for that firmware.',
      'A test machine to verify the messages before schools rely on it.',
    ],
  },
  zkteco_lan: {
    method: 'zkteco_lan',
    label: 'ZKTeco over the local network',
    status: 'planned',
    usable: false,
    description:
      'Reading attendance from a ZKTeco machine over the school’s LAN. A cloud service cannot reach a machine inside the school network, so this would run in the Local connector. Not built yet.',
    steps: [
      'The model, firmware and communication protocol of the machine (from ZKTeco’s official SDK/documentation).',
      'The Local connector (below) to run it on a PC in the school.',
      'A test machine.',
    ],
  },
  suprema_biostar2: {
    method: 'suprema_biostar2',
    label: 'Suprema BioStar 2',
    status: 'planned',
    usable: false,
    description: 'Reading events from a school’s Suprema BioStar 2 server through its API. Not built yet.',
    steps: [
      'The BioStar 2 version the school runs and Suprema’s API documentation for it.',
      'A BioStar 2 account with read-only access to events, and a way to reach the server (usually through the Local connector).',
    ],
  },
  local_connector: {
    method: 'local_connector',
    label: 'Local connector (PC in the school: LAN, USB cable or serial)',
    status: 'planned',
    usable: false,
    description:
      'A small program on a school PC that reads from machines connected by network, USB cable or serial port and sends the punches through the Connector API. Not built yet. (A USB cable to the PC is different from copying an export file with a USB flash drive, which works today through File import.)',
    steps: [
      'The machines the school uses (model, firmware, connection) and their official SDKs or protocols.',
      'A Windows PC that stays on during school hours.',
      'It would send punches through the Connector API, which is already available.',
    ],
  },
};

export const listIntegrations = () => INTEGRATION_METHODS.map((m) => INTEGRATIONS[m]);

/**
 * What every live adapter will implement. Today only the shared ingestion behind it exists
 * (biometric.service ingestPunches); live adapters are added by implementing this interface.
 */
export interface DeviceAdapter {
  method: IntegrationMethod;
  /** Check the settings and that the device or server answers. Never reports success without asking it. */
  testConnection(device: { _id: unknown }): Promise<{ ok: boolean; message: string }>;
  /** Punches recorded since `since` (or all the device holds). */
  fetchPunches(
    device: { _id: unknown },
    since?: Date,
  ): Promise<Array<{ deviceUserId: string; punchedAt: Date; punchType?: string }>>;
}
