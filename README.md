# Support Bot Helper

## Production Deployment

Production runs on AWS EC2 via Docker Compose.

```bash
# Deploy
scp -i <key.pem> <changed-files> ec2-user@<EC2_HOST>:<remote-path>
ssh -i <key.pem> ec2-user@<EC2_HOST> \
  'cd ~/support-bot-helper && docker compose -f docker-compose.production.yml up -d --build'

# Reset DB prompt after system-prompt.md changes
curl -X POST http://<EC2_HOST>:5002/api/settings/reset \
  -H "x-user-email: <admin-email>"
```

The app container listens on port `5000`; the production compose maps it to host port `5002`.

Keep production secrets in `.env.production` on the VM. Do not commit `.env` files.
