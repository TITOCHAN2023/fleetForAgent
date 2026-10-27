import {googleProfileEmail} from './oauth-account.mjs';

export async function fetchGoogleProfile({code,clientId,clientSecret,redirectUri},fetcher=fetch) {
  const tokenResponse=await fetcher('https://oauth2.googleapis.com/token',{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({code,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code'}),
  });
  if (!tokenResponse.ok) throw new Error('Google token exchange failed');
  const token=await tokenResponse.json();
  if (typeof token.access_token!=='string'||!token.access_token) throw new Error('Google token exchange failed');
  const profileResponse=await fetcher('https://www.googleapis.com/oauth2/v2/userinfo',{
    redirect:'manual',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${token.access_token}`},
  });
  if (!profileResponse.ok) throw new Error('Google profile request failed');
  const result=googleProfileEmail(await profileResponse.json());
  if (!result.ok) throw new Error(result.error);
  // Return only the verified identity; never forward Google's access token.
  return {email:result.email,verified_email:true};
}

export async function googleLoginProfile(env,code,redirectUri,fetcher=fetch) {
  if (!env.GOOGLE_RELAY_URL) return fetchGoogleProfile({code,redirectUri,clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET},fetcher);
  const url=new URL(env.GOOGLE_RELAY_URL);
  if (url.protocol!=='https:'||url.username||url.password||!env.GOOGLE_RELAY_SECRET) throw new Error('Google relay configuration invalid');
  const response=await fetcher(url.href,{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(35000),
    headers:{authorization:`Bearer ${env.GOOGLE_RELAY_SECRET}`,'content-type':'application/json','user-agent':'FleetHub/1.0'},
    body:JSON.stringify({code,redirect_uri:redirectUri}),
  });
  if (!response.ok) throw new Error('Google login relay unavailable');
  const result=googleProfileEmail(await response.json());
  if (!result.ok) throw new Error(result.error);
  return {email:result.email,verified_email:true};
}
