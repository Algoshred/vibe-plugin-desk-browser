/**
 * Sign a VibeControls plugin package for release (BOFF-16561), and prove the
 * packed tarball carries a signature the agent will accept.
 *
 *   PLUGIN_SIGNING_KEY=<pkcs8 pem> bun sign.ts sign   --dir <package dir> --key-id <id>
 *   PLUGIN_SIGNING_KEY=<pkcs8 pem> bun sign.ts verify --dir <package dir>
 *
 * `sign` lists the files `npm pack` would publish, hashes each with SHA-512,
 * signs the manifest with the Ed25519 key and writes `vibe-plugin.sig.json`.
 * `verify` packs the package for real, unpacks the tarball and checks it the
 * way the agent does (`vibecontrols-agent` `src/core/plugin-signature.ts`):
 * every file is listed, every hash matches, nothing extra is present, the
 * signature verifies with the public half of the key, and package.json names
 * the signed package and version. Both must agree on `canonicalPayload`; the
 * golden vector in tests/sign-plugin.test.ts is asserted by the agent too.
 *
 * The key never leaves the environment variable: it is not written to disk or
 * printed.
 *
 * Exit: 0 done, 1 verification failed, 2 usage or input error.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

export const SIGNATURE_FORMAT = 'vibecontrols-plugin-signature/v1';
export const SIGNATURE_FILE = 'vibe-plugin.sig.json';

export class SignError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 2,
  ) {
    super(message);
  }
}

export interface Manifest {
  package: string;
  version: string;
  keyId: string;
  files: Record<string, string>;
}

/** The subset of spawnSync the signer uses, so tests can stand in for npm. */
export type Run = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: 'utf8' },
) => { status: number | null; stdout: string; stderr: string };

const spawn: Run = (command, args, options) => spawnSync(command, args, options);

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The bytes that are signed. Must match the agent's `canonicalPayload`. */
export function canonicalPayload(m: Manifest): Buffer {
  const lines = [SIGNATURE_FORMAT, m.package, m.version, m.keyId];
  for (const path of Object.keys(m.files).sort(byteOrder)) lines.push(`${path}\t${m.files[path]}`);
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export function sha512Sri(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readPackageJson(dir: string): { name: string; version: string } {
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    throw new SignError(`${dir}/package.json is missing or not JSON`);
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new SignError('package.json has no name or version');
  }
  return { name: pkg.name, version: pkg.version };
}

/** The files `npm pack` would put in the tarball, as package-relative paths. */
export function packedFiles(dir: string, run: Run = spawn): string[] {
  const r = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new SignError(`npm pack --dry-run failed: ${r.stderr.trim()}`);
  let parsed: Array<{ files?: Array<{ path?: unknown }> }>;
  try {
    parsed = JSON.parse(r.stdout) as typeof parsed;
  } catch {
    throw new SignError('npm pack --dry-run did not print JSON');
  }
  const files = (parsed[0]?.files ?? [])
    .map((f) => (typeof f.path === 'string' ? f.path.replace(/^\.\//, '') : ''))
    .filter((p) => p !== '');
  return [...new Set(files)].sort(byteOrder);
}

function privateKeyFromEnv(env: NodeJS.ProcessEnv): ReturnType<typeof createPrivateKey> {
  const pem = env.PLUGIN_SIGNING_KEY;
  if (!pem) throw new SignError('PLUGIN_SIGNING_KEY is not set');
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new SignError('PLUGIN_SIGNING_KEY is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new SignError('PLUGIN_SIGNING_KEY is not an Ed25519 key');
  return key;
}

/** Write `vibe-plugin.sig.json` for the package in `dir`. Returns the manifest. */
export function signPackage(
  dir: string,
  keyId: string,
  env: NodeJS.ProcessEnv = process.env,
  list: (dir: string) => string[] = packedFiles,
): Manifest {
  if (!KEY_ID_RE.test(keyId)) throw new SignError(`invalid key id '${keyId}'`);
  const key = privateKeyFromEnv(env);
  const pkg = readPackageJson(dir);
  const files: Record<string, string> = {};
  for (const rel of list(dir)) {
    if (rel === SIGNATURE_FILE) continue;
    files[rel] = sha512Sri(readFileSync(join(dir, ...rel.split('/'))));
  }
  if (!files['package.json']) throw new SignError('npm pack would not include package.json');
  const manifest: Manifest = { package: pkg.name, version: pkg.version, keyId, files };
  const signature = sign(null, canonicalPayload(manifest), key).toString('base64');
  writeFileSync(
    join(dir, SIGNATURE_FILE),
    `${JSON.stringify({ format: SIGNATURE_FORMAT, ...manifest, signature }, null, 2)}\n`,
  );
  return manifest;
}

/** Every regular file under `root` except node_modules and the signature. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      if (rel === 'node_modules' || rel === SIGNATURE_FILE) continue;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) throw new SignError(`symbolic link ${rel} in the package`, 1);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out.sort(byteOrder);
}

/**
 * Check an unpacked package directory the way the agent does. Throws a
 * SignError (exit 1) naming the first problem.
 */
export function verifyUnpacked(dir: string, publicKeyPem: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(join(dir, SIGNATURE_FILE), 'utf8');
  } catch {
    throw new SignError(`${SIGNATURE_FILE} is not in the package; add it to package.json "files"`, 1);
  }
  const sig = JSON.parse(raw) as Manifest & { format?: unknown; signature?: unknown };
  if (sig.format !== SIGNATURE_FORMAT || typeof sig.signature !== 'string') {
    throw new SignError('the signature file is not v1', 1);
  }
  const manifest: Manifest = { package: sig.package, version: sig.version, keyId: sig.keyId, files: sig.files };
  if (!verify(null, canonicalPayload(manifest), createPublicKey(publicKeyPem), Buffer.from(sig.signature, 'base64'))) {
    throw new SignError('the signature does not verify', 1);
  }
  const present = walk(dir);
  for (const rel of present) {
    if (!(rel in manifest.files)) throw new SignError(`${rel} is in the package but not signed`, 1);
  }
  for (const [rel, expected] of Object.entries(manifest.files)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, ...rel.split('/')));
    } catch {
      throw new SignError(`${rel} is signed but not in the package`, 1);
    }
    if (sha512Sri(bytes) !== expected) throw new SignError(`${rel} does not match its signature`, 1);
  }
  const pkg = readPackageJson(dir);
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) {
    throw new SignError('package.json name or version differs from the signature', 1);
  }
  return manifest;
}

/** Pack the package for real, unpack the tarball and verify it. */
export function verifyPacked(dir: string, env: NodeJS.ProcessEnv = process.env, run: Run = spawn): Manifest {
  const publicKeyPem = createPublicKey(privateKeyFromEnv(env)).export({ type: 'spki', format: 'pem' }).toString();
  const work = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'sign-plugin-'));
  try {
    const pack = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], {
      cwd: dir,
      encoding: 'utf8',
    });
    if (pack.status !== 0) throw new SignError(`npm pack failed: ${pack.stderr.trim()}`);
    const tarball = (JSON.parse(pack.stdout) as Array<{ filename?: string }>)[0]?.filename;
    if (!tarball) throw new SignError('npm pack did not report a tarball');
    const untar = run('tar', ['-xzf', join(work, tarball), '-C', work], { encoding: 'utf8' });
    if (untar.status !== 0) throw new SignError(`could not unpack ${tarball}: ${untar.stderr.trim()}`);
    return verifyUnpacked(join(work, 'package'), publicKeyPem);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const consoleIo: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = consoleIo): number {
  const [command] = argv;
  const dir = arg(argv, '--dir') ?? '.';
  try {
    if (command === 'sign') {
      const keyId = arg(argv, '--key-id') ?? env.PLUGIN_SIGNING_KEY_ID ?? '';
      const m = signPackage(dir, keyId, env);
      io.out(`signed ${m.package}@${m.version}: ${Object.keys(m.files).length} files, key ${m.keyId}`);
      return 0;
    }
    if (command === 'verify') {
      const m = verifyPacked(dir, env);
      io.out(`verified the packed ${m.package}@${m.version}: ${Object.keys(m.files).length} files, key ${m.keyId}`);
      return 0;
    }
    io.err('usage: sign.ts sign|verify --dir <package dir> [--key-id <id>]');
    return 2;
  } catch (err) {
    if (err instanceof SignError) {
      io.err(`::error::${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
