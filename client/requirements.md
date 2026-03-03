## Packages
framer-motion | Page transitions and layout animations for the widget mode
react-markdown | Rendering structured AI responses
date-fns | Formatting timestamps for chat messages
lucide-react | Already in stack, but noting reliance on it for beautiful icons

## Notes
The application relies on SSE streaming at `POST /api/conversations/:id/messages`. 
The client implements a buffered text decoder to handle the SSE chunks robustly.
