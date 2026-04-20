// Netlify Function – invite-user.js
// Bjuder in användare via Netlify Identity Admin API och sätter roll direkt

exports.handler = async function(event, context) {
  // Endast POST tillåts
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Hämta miljövariabler
  const ADMIN_TOKEN = process.env.NETLIFY_ADMIN_TOKEN;
  const SITE_ID = process.env.NETLIFY_SITE_ID;

  if (!ADMIN_TOKEN || !SITE_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Serverkonfiguration saknas. Kontakta administratören.' })
    };
  }

  // Verifiera att anropet kommer från en inloggad admin
  const authHeader = event.headers.authorization || '';
  const userToken = authHeader.replace('Bearer ', '');

  if (!userToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Ej behörig.' }) };
  }

  // Verifiera användarens roll via Netlify Identity
  let callerUser;
  try {
    const verifyRes = await fetch(`https://${SITE_ID}.netlify.app/.netlify/identity/user`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    if (!verifyRes.ok) throw new Error('Kunde inte verifiera användare');
    callerUser = await verifyRes.json();
  } catch(e) {
    // Try with actual domain
    try {
      const verifyRes = await fetch(`https://app.oresundshuset.se/.netlify/identity/user`, {
        headers: { 'Authorization': `Bearer ${userToken}` }
      });
      if (!verifyRes.ok) throw new Error('Ej behörig');
      callerUser = await verifyRes.json();
    } catch(e2) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Ej behörig.' }) };
    }
  }

  // Kontrollera att anroparen är admin
  const callerRoles = (callerUser.app_metadata && callerUser.app_metadata.roles) || [];
  if (!callerRoles.includes('admin')) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Endast admin kan bjuda in användare.' }) };
  }

  // Hämta inbjudningsdata
  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltig request.' }) };
  }

  const { email, role, lgh } = body;

  if (!email || !role) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-post och roll krävs.' }) };
  }

  const validRoles = ['admin', 'forvaltare', 'hyresgast'];
  if (!validRoles.includes(role)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ogiltig roll.' }) };
  }

  try {
    // Steg 1: Skapa/bjud in användaren via Netlify Admin API
    const inviteRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/identity/users/invite`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    const inviteData = await inviteRes.json();

    if (!inviteRes.ok) {
      // Användaren kanske redan finns
      if (inviteData.code === 422 || (inviteData.msg && inviteData.msg.includes('already'))) {
        return {
          statusCode: 422,
          body: JSON.stringify({ error: `${email} är redan registrerad. Uppdatera rollen direkt i Netlify Identity.` })
        };
      }
      throw new Error(inviteData.msg || 'Kunde inte skicka inbjudan');
    }

    const userId = inviteData.id;

    // Steg 2: Sätt roll och eventuell lägenhet via Admin API
    const userMeta = role === 'hyresgast' && lgh ? { lgh } : {};

    const updateRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/identity/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_metadata: { roles: [role] },
        user_metadata: userMeta
      })
    });

    if (!updateRes.ok) {
      const updateErr = await updateRes.json().catch(() => ({}));
      throw new Error(updateErr.msg || 'Inbjudan skickad men roll kunde inte sättas. Sätt rollen manuellt i Netlify.');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: `Inbjudan skickad till ${email} med rollen ${role}.${role === 'hyresgast' && lgh ? ` Kopplad till lgh ${lgh}.` : ''}`
      })
    };

  } catch(e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message || 'Ett fel uppstod.' })
    };
  }
};
