# How do I contribute to slacker?

1. Create a slack app at https://api.slack.com/apps
2. Upload the manifest file `manifest.yml` to your app
3. Replace <YOUR_NGROK_URL> with a proxy tunnel url pointing to your local machine
4. Install the app to your workspace
5. Create a new Github app at https://github.com/settings/applications/new
6. Set the callback url to <YOUR_NGROK_URL>/auth/callback
7. Generate client secrets and private keys (encode your private key with base64 - because it is multiline)
8. Permissions: Contents, Issues, Pull requests, Metadata, Webhooks - Read-only | Email address - Read-only
9. Set these .env variables in your local environment:
    - SLACK_SIGNING_SECRET
    - SLACK_CLIENT_ID
    - SLACK_CLIENT_SECRET
    - SLACK_APP_TOKEN
    - SECRET_COOKIE_PASSWORD (RANDOM_STRING)
    - SLACK_BOT_TOKEN
    - ACTIVITY_LOG_CHANNEL_ID (#bot_spam recommended)
    - DATABASE_URL
    - GITHUB_APP_ID
    - GITHUB_CLIENT_ID
    - GITHUB_CLIENT_SECRET
    - GITHUB_PRIVATE_KEY (should be base64 encoded)
    - DEPLOY_URL (your ngrok url)

10. Setup a local postgres database and get a DATABASE_URL (e.g. postgres://user:password@localhost:5432/database)
    - You can use vercel-pg to run a postgres database
11. Run `yarn` and `yarn dev` to start the app