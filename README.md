# Support Bot Helper

## Production VM Access

Primary EC2 host:

```powershell
ssh -i "C:\Users\Vrishank Gupta\.ssh\analytics-report-key.pem" `
  -L 3306:127.0.0.1:3306 -N -f `
  -o StrictHostKeyChecking=no `
  -o ServerAliveInterval=30 `
  -o ServerAliveCountMax=10 `
  ec2-user@ec2-15-207-57-132.ap-south-1.compute.amazonaws.com
```

Interactive shell:

```powershell
ssh -i "C:\Users\Vrishank Gupta\.ssh\analytics-report-key.pem" `
  -o StrictHostKeyChecking=no `
  ec2-user@ec2-15-207-57-132.ap-south-1.compute.amazonaws.com
```

Production deployment uses Docker Compose with `docker-compose.production.yml`.
The app container listens on port `5000`; the production compose file maps it to host port `5002`.

Keep production secrets in `.env.production` on the VM. Do not commit local `.env` files.
