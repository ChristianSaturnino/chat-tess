import { closeDb } from './client';
import { runMigrations } from './migrator';

runMigrations()
  .then(() => console.log('migrations aplicadas'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
