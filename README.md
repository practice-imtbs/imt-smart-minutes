# IMT Smart Minutes

**De votre enregistrement au compte rendu, en quelques clics.**
Une application du service PracTice, IMT Business School.

👉 **Utiliser l'application : https://practice-imtbs.github.io/imt-smart-minutes/**

## Ce que fait l'application

1. **Transcrire** l'enregistrement d'une réunion (celui de votre téléphone suffit) avec le modèle Voxtral de Mistral AI, en **distinguant automatiquement les intervenants**.
2. **Nommer les intervenants** (facultatif) : écoutez la première prise de parole de chacun et saisissez son nom, ou laissez l'IA le proposer.
3. **Récupérer la transcription** : copier le texte ou le télécharger (.txt, .md).
4. **Générer un compte rendu** structuré (synthèse, sections par thème, relevé de décisions et d'actions), puis le **télécharger en Word (.docx)**, le copier ou le télécharger en .md.

## Obtenir une clé API Mistral

L'application utilise votre propre clé Mistral. Mistral propose un crédit gratuit à l'inscription.

1. Créez un compte sur [console.mistral.ai](https://console.mistral.ai/).
2. Activez l'offre d'essai ou le plan « Experiment ».
3. Menu **API Keys** puis **Create new key**. Copiez la clé : elle ne s'affiche qu'une fois.
4. Collez-la dans l'application et cliquez sur **Tester**.

À titre indicatif, une heure de réunion coûte environ 0,20 € de transcription, plus quelques centimes pour la rédaction du compte rendu.

## Confidentialité

- L'application est un site statique : il n'y a **aucun serveur** et **aucune base de données**.
- L'audio et la transcription ne sont envoyés **qu'à l'API Mistral**. Tout disparaît à la fermeture de l'onglet.
- La clé API reste dans votre navigateur. Elle n'est mémorisée sur l'appareil que si vous cochez « Mémoriser ma clé ».
- Ne traitez pas de données sensibles sans la validation de votre établissement.

## Limites

- Audio uniquement (mp3, m4a, wav, ogg, flac, webm). Pour une vidéo, extrayez d'abord la piste audio.
- Jusqu'à environ 3 heures d'enregistrement par fichier (limite de Voxtral).
- Le compte rendu est produit par une IA : **relisez-le toujours** avant de le diffuser.

## Aspects techniques

| Élément | Choix |
|---|---|
| Transcription et séparation des intervenants | `voxtral-mini-2602` (Voxtral Mini Transcribe V2), `diarize=true` |
| Noms et compte rendu | `mistral-medium-latest` par défaut (Large ou Small au choix) |
| Export Word | librairie [`docx`](https://www.npmjs.com/package/docx) 8.5, dans le navigateur |
| Hébergement | GitHub Pages |

Fichiers : `index.html` (interface), `style.css` (charte PracTice), `app.js` (logique).

### Lancer en local

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000.
