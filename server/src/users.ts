// Pure helpers for the users.json store + password hashing. Imported by both
// the auth route and the CLI tools — keep it free of fastify deps.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type User = {
  id: string;
  name: string;
  passwordHash: string; // hex
  salt: string;         // hex
  createdAt: number;
};

const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');

// scrypt params. N=2^14 keeps the verify step ~25ms on modern hardware and
// stays under Node's default 32MB scrypt memory limit (128*N*r). Bumping
// higher would require explicit maxmem and isn't worth it for a small-scale
// internal service.
const SCRYPT_PARAMS = { N: 1 << 14, r: 8, p: 1 } as const;
const KEY_LEN = 32;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function listUsers(): Promise<User[]> {
  return readJson<User[]>(USERS_FILE, []);
}

export async function findUserByName(name: string): Promise<User | null> {
  const users = await listUsers();
  const lc = name.trim().toLowerCase();
  return users.find((u) => u.name.toLowerCase() === lc) ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const users = await listUsers();
  return users.find((u) => u.id === id) ?? null;
}

export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

export function hashPassword(password: string, salt: string): string {
  const buf = scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return buf.toString('hex');
}

export function verifyPassword(password: string, user: User): boolean {
  const calc = scryptSync(password, user.salt, KEY_LEN, SCRYPT_PARAMS);
  const stored = Buffer.from(user.passwordHash, 'hex');
  if (calc.length !== stored.length) return false;
  return timingSafeEqual(calc, stored);
}

export async function addUser(name: string, password: string): Promise<User> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name required');
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error('name must be alphanumeric (or _ / -)');
  }
  if (password.length < 6) throw new Error('password must be at least 6 chars');
  const users = await listUsers();
  if (users.some((u) => u.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`user "${trimmed}" already exists`);
  }
  const salt = generateSalt();
  const user: User = {
    id: randomUUID(),
    name: trimmed,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: Date.now(),
  };
  users.push(user);
  await writeJson(USERS_FILE, users);
  return user;
}

export async function removeUser(name: string): Promise<boolean> {
  const users = await listUsers();
  const lc = name.trim().toLowerCase();
  const next = users.filter((u) => u.name.toLowerCase() !== lc);
  if (next.length === users.length) return false;
  await writeJson(USERS_FILE, next);
  return true;
}

export async function setPassword(name: string, password: string): Promise<boolean> {
  if (password.length < 6) throw new Error('password must be at least 6 chars');
  const users = await listUsers();
  const lc = name.trim().toLowerCase();
  const idx = users.findIndex((u) => u.name.toLowerCase() === lc);
  if (idx < 0) return false;
  const salt = generateSalt();
  users[idx] = {
    ...users[idx],
    salt,
    passwordHash: hashPassword(password, salt),
  };
  await writeJson(USERS_FILE, users);
  return true;
}

// Used by migration / first-run logic: create a user without overwriting an
// existing one. Returns the created or existing user.
export async function ensureUser(name: string, password: string): Promise<User> {
  const existing = await findUserByName(name);
  if (existing) return existing;
  return addUser(name, password);
}
