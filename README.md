# KC External Offers Service

Isolated service for **External Sales Log** flow:
- Receives `POST /external-offers` from Airtable automation
- Sends Offer messages to sellers (Discord)
- On Accept: creates Sale, decrements Inventory, sets `Offer Status = Confirmed` on External record
- Helpers: `POST /disable-offers`, `GET /health`

## Run locally

```bash
cp .env.example .env
# fill secrets
npm i
npm start
