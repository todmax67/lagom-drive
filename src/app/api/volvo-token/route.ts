export async function POST(request: Request) {
  const body = await request.text();
  
  const clientId = process.env.VOLVO_CLIENT_ID!;
  const clientSecret = process.env.VOLVO_CLIENT_SECRET!;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://volvoid.eu.volvocars.com/as/token.oauth2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body,
  });

  const data = await response.json();
  return Response.json(data, { status: response.status });
}