# TurniSync PWA – guida da iPhone

## Cosa fa questa versione
- PWA installabile dalla schermata Home quando pubblicata su HTTPS.
- Selezione screenshot dalla libreria.
- OCR con Tesseract.js nel browser: il file immagine viene elaborato localmente e non viene inviato a un backend TurniSync.
- Selezione persone, modifica/rimozione turni, orari personalizzabili.
- Esportazione `.ics` per importare gli eventi in Apple Calendar.

## Limiti da conoscere
1. Questa non è un'app nativa iOS: Safari non espone EventKit. Gli eventi vengono esportati in un file `.ics` e importati dall'utente.
2. Il motore OCR Tesseract.js e i dati lingua vengono scaricati dal CDN al primo avvio/analisi. L'immagine selezionata non viene caricata sul CDN.
3. Il parser è euristico e si aspetta date riconoscibili nell'intestazione e codici 1/2/3 nelle celle. Tabelle reali possono richiedere miglioramenti. Verificare SEMPRE l'anteprima.
4. Il parser usa l'anno corrente se lo screenshot mostra solo giorno/mese. Correggere la data quando necessario.
5. Il controllo duplicati evita doppioni nello stesso file esportato; non legge il calendario già presente sul telefono.

## Pubblicazione gratuita da iPhone con GitHub Pages
È necessario pubblicare questi file su un URL HTTPS. GitHub Pages offre hosting statico gratuito per repository pubblici.

1. Apri https://github.com/ e accedi/crea un account.
2. Crea un repository pubblico chiamato `turnisync`.
3. Carica tutti i file e la cartella `icons` mantenendo la struttura. Da iPhone puoi usare GitHub nel browser oppure l'app File per selezionare i file.
4. Nel repository vai su Settings → Pages.
5. In "Build and deployment" seleziona "Deploy from a branch", branch `main`, folder `/ (root)`, quindi Save.
6. Attendi la pubblicazione: l'indirizzo sarà `https://TUO-USERNAME.github.io/turnisync/`.
7. Apri quell'indirizzo in Safari su iPhone → pulsante Condividi → Aggiungi alla schermata Home.

## Test iniziale consigliato
- Usa uno screenshot ben nitido, non ritagliato, con intestazioni data e nomi visibili.
- Prova prima con una sola persona.
- Controlla tutte le date e gli orari nell'anteprima.
- Per il turno notte verifica che l'ora finale sia il giorno successivo.
- Esporta il file `.ics`, aprilo da File e importa gli eventi nel Calendario.
