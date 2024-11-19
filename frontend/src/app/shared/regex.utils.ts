import { Env } from '../services/state.service';

// all base58 characters
export const BASE58_CHARS = `[a-km-zA-HJ-NP-Z1-9]`;

// all bech32 characters (after the separator)
export const BECH32_CHARS_LW = `[ac-hj-np-z02-9]`;
const BECH32_CHARS_UP = `[AC-HJ-NP-Z02-9]`;

// Hex characters
export const HEX_CHARS = `[a-fA-F0-9]`;

// A regex to say "A single 0 OR any number with no leading zeroes"
// Capped at 9 digits so as to not be confused with lightning channel IDs (which are around 17 digits)
// (?:             // Start a non-capturing group
//   0             // A single 0
//   |             // OR
//   [1-9][0-9]{0,8} // Any succession of numbers up to 9 digits starting with 1-9
// )               // End the non-capturing group.
const ZERO_INDEX_NUMBER_CHARS = `(?:0|[1-9][0-9]{0,8})`;

// Simple digits only regex
const NUMBER_CHARS = `[0-9]`;

// Formatting of the address regex is for readability,
// We should ignore formatting it with automated formatting tools like prettier.
//
// prettier-ignore
const ADDRESS_CHARS: {
  [k in Network]: {
    base58: string;
    bech32: string;
  };
} = {
  doge: {
    base58: `[D9]` // Starts with a single D or 9 (P2PKH is D, P2SH is 9)
      + BASE58_CHARS
      + `{26,34}`, // D is 34 length, 9 is 34 length
    // segwit is not enabled on doge... so this code is irrelevant
    bech32: `(?:`
        + `doge1` // Starts with doge1
        + BECH32_CHARS_LW
        + `{6,100}` // As per bech32, 6 char checksum is minimum
      + `|`
        + `DOGE1` // All upper case version
        + BECH32_CHARS_UP
        + `{6,100}`
      + `)`,
  },
}
type RegexTypeNoAddrNoBlockHash = | `transaction` | `blockheight` | `date` | `timestamp`;
export type RegexType = `address` | `blockhash` | RegexTypeNoAddrNoBlockHash;

export const NETWORKS = [`doge`] as const;
export type Network = typeof NETWORKS[number]; // Turn const array into union type

export const ADDRESS_REGEXES: [RegExp, Network][] = NETWORKS
  .map(network => [getRegex('address', network), network])

export function findOtherNetworks(address: string, skipNetwork: Network, env: Env): { network: Network, address: string, isNetworkAvailable: boolean }[] {
  return ADDRESS_REGEXES
    .filter(([regex, network]) => network !== skipNetwork && regex.test(address))
    .map(([, network]) => ({ network, address, isNetworkAvailable: isNetworkAvailable(network, env) }));
}

function isNetworkAvailable(network: Network, env: Env): boolean {
  switch (network) {
    case 'doge':
      return env.DOGE_ENABLED === true;
    default:
      return false;
  }
}

export function getTargetUrl(toNetwork: Network, address: string, env: Env): string {
  let targetUrl = '';
  if (toNetwork === 'doge') {
    targetUrl = env.MEMPOOL_WEBSITE_URL;
    targetUrl += (toNetwork === 'doge' ? '' : `/${toNetwork}`);
    targetUrl += '/address/';
    targetUrl += address;
  }
  return targetUrl;
}

export function getRegex(type: RegexTypeNoAddrNoBlockHash): RegExp;
export function getRegex(type: 'address', network: Network): RegExp;
export function getRegex(type: 'blockhash', network: Network): RegExp;
export function getRegex(type: RegexType, network?: Network): RegExp {
  let regex = `^`; // ^ = Start of string
  switch (type) {
    // Match a block height number
    // [Testing Order]: any order is fine
    case `blockheight`:
      regex += ZERO_INDEX_NUMBER_CHARS; // block height is a 0 indexed number
      break;
    // Match a 32 byte block hash in hex.
    // [Testing Order]: Must always be tested before `transaction`
    case `blockhash`:
      if (!network) {
        throw new Error(`Must pass network when type is blockhash`);
      }
      let leadingZeroes: number;
      switch (network) {
        case `doge`:
          leadingZeroes = 8; // Assumes at least 32 bits of difficulty
          break;
        default:
          throw new Error(`Invalid Network ${network} (Unreachable error in TypeScript)`);
      }
      regex += `0{${leadingZeroes}}`;
      regex += `${HEX_CHARS}{${64 - leadingZeroes}}`; // Exactly 64 hex letters/numbers
      break;
    // Match a 32 byte tx hash in hex. Contains optional output index specifier.
    // [Testing Order]: Must always be tested after `blockhash`
    case `transaction`:
      regex += `${HEX_CHARS}{64}`; // Exactly 64 hex letters/numbers
      regex += `(?:`; // Start a non-capturing group
      regex += `:`; // 1 instances of the symbol ":"
      regex += ZERO_INDEX_NUMBER_CHARS; // A zero indexed number
      regex += `)?`; // End the non-capturing group. This group appears 0 or 1 times
      break;
    // Match any one of the many address types
    // [Testing Order]: While possible that a bech32 address happens to be 64 hex
    // characters in the future (current lengths are not 64), it is highly unlikely
    // Order therefore, does not matter.
    case `address`:
      if (!network) {
        throw new Error(`Must pass network when type is address`);
      }
      regex += `(?:`; // Start a non-capturing group (each network has multiple options)
      switch (network) {
        case `doge`:
          regex += ADDRESS_CHARS.doge.base58;
          regex += `|`; // OR
          regex += ADDRESS_CHARS.doge.bech32;
          break;
        default:
          throw new Error(`Invalid Network ${network} (Unreachable error in TypeScript)`);
      }
      regex += `)`; // End the non-capturing group
      break;
    // Match a date in the format YYYY-MM-DD (optional: HH:MM)
    // [Testing Order]: any order is fine
    case `date`:
      regex += `(?:`;                  // Start a non-capturing group
      regex += `${NUMBER_CHARS}{4}`;   // Exactly 4 digits
      regex += `[-/]`;                 // 1 instance of the symbol "-" or "/"
      regex += `${NUMBER_CHARS}{1,2}`; // Exactly 4 digits
      regex += `[-/]`;                 // 1 instance of the symbol "-" or "/"
      regex += `${NUMBER_CHARS}{1,2}`; // Exactly 4 digits
      regex += `(?:`;                  // Start a non-capturing group
      regex += ` `;                    // 1 instance of the symbol " "
      regex += `${NUMBER_CHARS}{1,2}`; // Exactly 4 digits
      regex += `:`;                    // 1 instance of the symbol ":"
      regex += `${NUMBER_CHARS}{1,2}`; // Exactly 4 digits
      regex += `)?`;                   // End the non-capturing group. This group appears 0 or 1 times
      regex += `)`;                    // End the non-capturing group
      break;
    // Match a unix timestamp
    // [Testing Order]: any order is fine
    case `timestamp`:
      regex += `${NUMBER_CHARS}{10}`; // Exactly 10 digits
      break;
    default:
      throw new Error(`Invalid RegexType ${type} (Unreachable error in TypeScript)`);
  }
  regex += `$`; // $ = End of string
  return new RegExp(regex);
}
