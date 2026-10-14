const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('External network disabled by isolated audit');return originalFetch(input,init)};
