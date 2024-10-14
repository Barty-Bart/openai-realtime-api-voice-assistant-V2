# OpenAI Realtime API Voice Assistant

This is an upgraded version of the V1 repo: https://github.com/Barty-Bart/openai-realtime-api-voice-assistant

This project implements an AI-powered inbound call agent for Bart's Automotive, a fictional automotive business. It uses OpenAI's new realtime API and integrates with Twilio to handle incoming phone calls.

## Tutorial Video

Watch the tutorial video here: https://youtu.be/ffDm4HVGuTM?si=kjulj6eTpe6p_w28

## Upgrades

This version now has:

- RAG using OpenAI Assistants API
- Function Calling
- Caller History

This version uses Make.com as the backend for processing all RAG and Function Calls. 

This means that you can simply copy the main index.js file, paste it into your favourite AI tool (e.g., ChatGPT) and ask it to modify the function calls for you.

And as a non-coder, you can now run all of your automations/ function calls within Make.com.

This entire build was made for beginners! Hope you enjoy :)

## Features

- Handles incoming calls using Twilio's voice services
- Utilizes OpenAI's realtime API for natural language processing
- Transcribes user speech and generates AI responses in real-time
- Extracts customer details (name, availability, and special notes) from the conversation
- Sends extracted information to a webhook for further processing

## Technologies Used

- Node.js
- Fastify (web framework)
- WebSocket (for real-time communication)
- OpenAI GPT-4 Realtime API
- Twilio (for telephony services)
- dotenv (for environment variable management)

## Setup

1. Clone the repository:
   ```
   git clone https://github.com/Barty-Bart/openai-realtime-api-voice-assistant-V2.git
   cd openai-realtime-api-voice-assistant-V2
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Set up environment variables:
   Create a `.env` file in the root directory and add the following:
   ```
   OPENAI_API_KEY=your_openai_api_key
   ```

4. Start the server:
   ```
   npm start
   ```

## Usage

Once the server is running, it will handle incoming Twilio calls. The AI agent will engage with callers, transcribe their speech, generate appropriate responses, and extract relevant information from the conversation.

## Note

This project is a demonstration and should be adapted for production use, including proper error handling, security measures, and compliance with relevant regulations.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
