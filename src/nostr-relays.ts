// Los relays donde el navegador puede hablar con los nodos de Mostro (comprar desde /nostr/). Son los que anuncian los
// nodos en sus órdenes (Kmbalache: los cuatro). La CSP de esa página solo deja abrir WebSocket a estos, y el cliente no
// conecta a ningún otro aunque una orden diga otra cosa
export const MOSTRO_RELAYS = ['wss://relay.mostro.network', 'wss://mostro-p2p.tech', 'wss://relay.shadowbip.com', 'wss://nos.lol']

// Una dirección Lightning (usuario@dominio, LUD-16). El dominio con un punto al menos: nada de localhost ni de IP sueltas
export const LN_ADDRESS = /^[a-z0-9._+-]{1,64}@(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i
// La que da QvaPay a cada cuenta: su usuario en qvpay.me
export const QVAPAY_LN_DOMAIN = 'qvpay.me'
