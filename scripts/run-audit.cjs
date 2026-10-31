const {spawnSync}=require('node:child_process');
const python=process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result=spawnSync(python,['scripts/audit-repo.py'],{stdio:'inherit'});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
