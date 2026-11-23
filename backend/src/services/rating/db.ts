import { pool } from '../../db/pool.js';

/** Rows of a query; the rating modules read many small lookup tables this way. */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

/** Case- and punctuation-insensitive key for county and city names. */
export const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
