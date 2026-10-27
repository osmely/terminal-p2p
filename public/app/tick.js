// Temporizador del bucle del libro con el radar de Pro encendido (web/main.ts): los navegadores frenan los de una
// pestaña oculta, pero no los de un worker
onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms)
