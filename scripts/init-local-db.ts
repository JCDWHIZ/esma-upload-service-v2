import { Client } from 'pg';

async function main() {
  const adminUrl = 'postgres://postgres:root@localhost:5432/postgres';
  const targetDb = 'esma-upload';

  const client = new Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (res.rowCount === 0) {
      await client.query(`CREATE DATABASE "${targetDb}"`);
      console.log(`Created database "${targetDb}" successfully.`);
    } else {
      console.log(`Database "${targetDb}" already exists.`);
    }
  } catch (err) {
    console.error('Failed to initialize local database:', err);
  } finally {
    await client.end();
  }
}

void main();
