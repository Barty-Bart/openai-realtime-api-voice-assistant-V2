// Import required modules
import Fastify from 'fastify';  // Web framework for Node.js
import WebSocket from 'ws';  // WebSocket library for real-time communication
import fs from 'fs';  // Filesystem module for reading/writing files
import dotenv from 'dotenv';  // Module to load environment variables from a .env file
import fastifyFormBody from '@fastify/formbody';  // Fastify plugin for parsing form data
import fastifyWs from '@fastify/websocket';  // Fastify plugin for WebSocket support
import fetch from 'node-fetch';  // Module to make HTTP requests

// Load environment variables from .env file
dotenv.config();  // Reads .env file and makes its variables available

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env;  // Get the OpenAI API key from the environment

// Check if the API key is missing
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);  // Exit the application if the API key is not found
}

// Initialize Fastify server
const fastify = Fastify();  // Create a new Fastify instance
fastify.register(fastifyFormBody);  // Register the form-body parsing plugin
fastify.register(fastifyWs);  // Register WebSocket support for real-time communication

// System message template for the AI assistant's behavior and persona
const SYSTEM_MESSAGE = `
### Role
You are an AI assistant named Sophie, working at Bart's Automotive. Your role is to answer customer questions about automotive services and repairs, and assist with booking tow services.
### Persona
- You have been a receptionist at Bart's Automotive for over 5 years.
- You are knowledgeable about both the company and cars in general.
- Your tone is friendly, professional, and efficient.
- You keep conversations focused and concise, bringing them back on topic if necessary.
- You ask only one question at a time and respond promptly to avoid wasting the customer's time.
### Conversation Guidelines
- Always be polite and maintain a medium-paced speaking style.
- When the conversation veers off-topic, gently bring it back with a polite reminder.
### First Message
The first message you receive from the customer is their name and a summary of their last call, repeat this exact message to the customer as the greeting.
### Handling FAQs
Use the function \`question_and_answer\` to respond to common customer queries.
### Booking a Tow
When a customer needs a tow:
1. Ask for their current address.
2. Once you have the address, use the \`book_tow\` function to arrange the tow service.
`;

// Some default constants used throughout the application
const VOICE = 'alloy';  // The voice for AI responses
const PORT = process.env.PORT || 5050;  // Set the port for the server (from environment or default to 5050)
const MAKE_WEBHOOK_URL = "<your Make.com URL>";  // URL to Make.com webhook

// Session management: Store session data for ongoing calls
const sessions = new Map();  // A Map to hold session data for each call

// Event types to log to the console for debugging purposes
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'response.text.done',
    'conversation.item.input_audio_transcription.completed'
];

// Root route - just for checking if the server is running
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });  // Send a simple message when accessing the root
});

// Handle incoming calls from Twilio
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call');  // Log incoming call for debugging

    // Get all incoming call details from the request body or query string
    const twilioParams = request.body || request.query;
    console.log('Twilio Inbound Details:', JSON.stringify(twilioParams, null, 2));  // Log call details

    // Extract caller's number and session ID (CallSid)
    const callerNumber = twilioParams.From || 'Unknown';  // Caller phone number (default to 'Unknown' if missing)
    const sessionId = twilioParams.CallSid;  // Use Twilio's CallSid as a unique session ID
    console.log('Caller Number:', callerNumber);
    console.log('Session ID (CallSid):', sessionId);

    // Send the caller's number to Make.com webhook to get a personalized first message
    let firstMessage = "Hello, welcome to Bart's Automotive. How can I assist you today?";  // Default first message

    try {
        // Send a POST request to Make.com webhook to get a customized message for the caller
        const webhookResponse = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                route: "1",  // Route 1 is for getting the first message
                data1: callerNumber,  // Send caller's number
                data2: "empty"  // Extra data (not used here)
            })
        });

        if (webhookResponse.ok) {
            const responseText = await webhookResponse.text();  // Get the text response from the webhook
            console.log('Make.com webhook response:', responseText);
            try {
                const responseData = JSON.parse(responseText);  // Try to parse the response as JSON
                if (responseData && responseData.firstMessage) {
                    firstMessage = responseData.firstMessage;  // If there's a firstMessage in the response, use it
                    console.log('Parsed firstMessage from Make.com:', firstMessage);
                }
            } catch (parseError) {
                console.error('Error parsing webhook response:', parseError);  // Log any errors while parsing the response
                firstMessage = responseText.trim();  // Use the plain text response if parsing fails
            }
        } else {
            console.error('Failed to send data to Make.com webhook:', webhookResponse.statusText);  // Log if webhook fails
        }
    } catch (error) {
        console.error('Error sending data to Make.com webhook:', error);  // Log if an error occurs in the request
    }

    // Set up a new session for this call
    let session = {
        transcript: '',  // Store the conversation transcript here
        streamSid: null,  // This will be set when the media stream starts
        callerNumber: callerNumber,  // Store the caller's number
        callDetails: twilioParams,  // Save the Twilio call details
        firstMessage: firstMessage  // Save the personalized first message
    };
    sessions.set(sessionId, session);  // Add the session to the sessions Map

    // Respond to Twilio with TwiML to connect the call to the media stream
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream">  // WebSocket URL for media stream
                                        <Parameter name="firstMessage" value="${firstMessage}" />  // Send the first message as a parameter
                                        <Parameter name="callerNumber" value="${callerNumber}" />  // Send caller number as a parameter
                                  </Stream>
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);  // Send the TwiML response to Twilio
});

// WebSocket route to handle the media stream for real-time interaction
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected to media-stream');  // Log when a client connects

        let firstMessage = '';  // Placeholder for the first message
        let streamSid = '';  // Placeholder for the stream ID
        let openAiWsReady = false;  // Flag to check if the OpenAI WebSocket is ready
        let queuedFirstMessage = null;  // Queue the first message until OpenAI WebSocket is ready
        let threadId = "";  // Initialize threadId for tracking conversation threads

        // Use Twilio's CallSid as the session ID or create a new one based on the timestamp
        const sessionId = req.headers['x-twilio-call-sid'] || `session_${Date.now()}`;
        let session = sessions.get(sessionId) || { transcript: '', streamSid: null };  // Get the session data or create a new session
        sessions.set(sessionId, session);  // Update the session Map

        // Retrieve the caller number from the session
        const callerNumber = session.callerNumber;
        console.log('Caller Number:', callerNumber);

        // Open a WebSocket connection to the OpenAI Realtime API
        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,  // Authorization header with the OpenAI API key
                "OpenAI-Beta": "realtime=v1"  // Use the beta realtime version
            }
        });

        // Function to send the session configuration to OpenAI
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },  // Enable voice activity detection
                    input_audio_format: 'g711_ulaw',  // Audio format for input
                    output_audio_format: 'g711_ulaw',  // Audio format for output
                    voice: VOICE,  // Use the defined voice for AI responses
                    instructions: SYSTEM_MESSAGE,  // Provide the AI assistant's instructions
                    modalities: ["text", "audio"],  // Use both text and audio for interaction
                    temperature: 0.8,  // Temperature for controlling the creativity of AI responses
                    input_audio_transcription: {
                        "model": "whisper-1"  // Use the Whisper model for transcribing audio
                    },
                    tools: [  // Define the tools (functions) the AI can use
                        {
                            type: "function",
                            name: "question_and_answer",
                            description: "Get answers to customer questions about automotive services and repairs",
                            parameters: {
                                type: "object",
                                properties: {
                                    "question": { "type": "string" }
                                },
                                required: ["question"]
                            }
                        },
                        {
                            type: "function",
                            name: "book_tow",
                            description: "Book a tow service for a customer",
                            parameters: {
                                type: "object",
                                properties: {
                                    "address": { "type": "string" }
                                },
                                required: ["address"]
                            }
                        }
                    ],
                    tool_choice: "auto"  // Automatically choose the tool
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));  // Send the session update to OpenAI
        };

        // Function to send the first message once OpenAI WebSocket is ready
        const sendFirstMessage = () => {
            if (queuedFirstMessage && openAiWsReady) {  // Check if we have a queued message and the connection is ready
                console.log('Sending queued first message:', queuedFirstMessage);
                openAiWs.send(JSON.stringify(queuedFirstMessage));  // Send the first message
                openAiWs.send(JSON.stringify({ type: 'response.create' }));  // Trigger AI to generate a response
                queuedFirstMessage = null;  // Clear the queue
            }
        };

        // Open event for when the OpenAI WebSocket connection is established
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');  // Log successful connection
            openAiWsReady = true;  // Set the flag to true
            sendSessionUpdate();  // Send session configuration
            sendFirstMessage();  // Send the first message if queued
        });

        // Handle messages from Twilio (media stream) and send them to OpenAI
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);  // Parse the incoming message from Twilio

                if (data.event === 'start') {  // When the call starts
                    streamSid = data.start.streamSid;  // Get the stream ID
                    const callSid = data.start.callSid;  // Get the call SID
                    const customParameters = data.start.customParameters;  // Get custom parameters (firstMessage, callerNumber)

                    console.log('CallSid:', callSid);
                    console.log('StreamSid:', streamSid);
                    console.log('Custom Parameters:', customParameters);

                    // Capture callerNumber and firstMessage from custom parameters
                    const callerNumber = customParameters?.callerNumber || 'Unknown';
                    session.callerNumber = callerNumber;  // Store the caller number in the session
                    firstMessage = customParameters?.firstMessage || "Hello, how can I assist you?";  // Set the first message
                    console.log('First Message:', firstMessage);
                    console.log('Caller Number:', callerNumber);

                    // Prepare the first message, but don't send it until the OpenAI connection is ready
                    queuedFirstMessage = {
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [{ type: 'input_text', text: firstMessage }]
                        }
                    };

                    if (openAiWsReady) {
                        sendFirstMessage();  // Send the first message if OpenAI is ready
                    }

                } else if (data.event === 'media') {  // When media (audio) is received
                    if (openAiWs.readyState === WebSocket.OPEN) {  // Check if the OpenAI WebSocket is open
                        const audioAppend = {
                            type: 'input_audio_buffer.append',  // Append audio data
                            audio: data.media.payload  // Audio data from Twilio
                        };
                        openAiWs.send(JSON.stringify(audioAppend));  // Send the audio data to OpenAI
                    }
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);  // Log any errors during message parsing
            }
        });

        // Handle incoming messages from OpenAI
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);  // Parse the message from OpenAI

                // Handle audio responses from OpenAI
                if (response.type === 'response.audio.delta' && response.delta) {
                    connection.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }  // Send audio back to Twilio
                    }));
                }

                // Handle function calls (for Q&A and booking a tow)
                if (response.type === 'response.function_call_arguments.done') {
                    console.log("Function called:", response);
                    const functionName = response.name;
                    const args = JSON.parse(response.arguments);  // Get the arguments passed to the function

                    if (functionName === 'question_and_answer') {  // If the Q&A function is called
                        const question = args.question;  // Get the question
                        try {
                            const webhookResponse = await sendToWebhook({
                                route: "3",  // Route 3 for Q&A
                                data1: question,
                                data2: threadId
                            });

                            console.log("Webhook response:", webhookResponse);

                            // Parse the webhook response
                            const parsedResponse = JSON.parse(webhookResponse);
                            const answerMessage = parsedResponse.message || "I'm sorry, I couldn't find an answer to that question.";

                            // Update the threadId if it's provided in the response
                            if (parsedResponse.thread) {
                                threadId = parsedResponse.thread;
                                console.log("Updated thread ID:", threadId);
                            }

                            const functionOutputEvent = {
                                type: "conversation.item.create",
                                item: {
                                    type: "function_call_output",
                                    role: "system",
                                    output: answerMessage,  // Provide the answer from the webhook
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutputEvent));  // Send the answer back to OpenAI

                            // Trigger AI to generate a response based on the answer
                            openAiWs.send(JSON.stringify({
                                type: "response.create",
                                response: {
                                    modalities: ["text", "audio"],
                                    instructions: `Respond to the user's question "${question}" based on this information: ${answerMessage}. Be concise and friendly.`,
                                }
                            }));
                        } catch (error) {
                            console.error('Error processing question:', error);
                            sendErrorResponse();  // Send an error response if something goes wrong
                        }
                    } else if (functionName === 'book_tow') {  // If the book_tow function is called
                        const address = args.address;  // Get the address
                        try {
                            const webhookResponse = await sendToWebhook({
                                route: "4",  // Route 4 for booking a tow
                                data1: session.callerNumber,
                                data2: address  // Send the address to the webhook
                            });

                            console.log("Webhook response:", webhookResponse);

                            // Parse the webhook response
                            const parsedResponse = JSON.parse(webhookResponse);
                            const bookingMessage = parsedResponse.message || "I'm sorry, I couldn't book the tow service at this time.";

                            const functionOutputEvent = {
                                type: "conversation.item.create",
                                item: {
                                    type: "function_call_output",
                                    role: "system",
                                    output: bookingMessage,  // Provide the booking status
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutputEvent));  // Send the booking status back to OpenAI

                            // Trigger AI to generate a response based on the booking
                            openAiWs.send(JSON.stringify({
                                type: "response.create",
                                response: {
                                    modalities: ["text", "audio"],
                                    instructions: `Inform the user about the tow booking status: ${bookingMessage}. Be concise and friendly.`,
                                }
                            }));
                        } catch (error) {
                            console.error('Error booking tow:', error);
                            sendErrorResponse();  // Send an error response if booking fails
                        }
                    }
                }

                // Log agent response
                if (response.type === 'response.done') {
                    const agentMessage = response.response.output[0]?.content?.find(content => content.transcript)?.transcript || 'Agent message not found';
                    session.transcript += `Agent: ${agentMessage}\n`;  // Add agent's message to the transcript
                    console.log(`Agent (${sessionId}): ${agentMessage}`);
                }

                // Log user transcription (input_audio_transcription.completed)
                if (response.type === 'conversation.item.input_audio_transcription.completed' && response.transcript) {
                    const userMessage = response.transcript.trim();  // Get the user's transcribed message
                    session.transcript += `User: ${userMessage}\n`;  // Add the user's message to the transcript
                    console.log(`User (${sessionId}): ${userMessage}`);
                }

                // Log other relevant events
                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle when the connection is closed
        connection.on('close', async () => {
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();  // Close the OpenAI WebSocket
            }
            console.log(`Client disconnected (${sessionId}).`);
            console.log('Full Transcript:');
            console.log(session.transcript);  // Log the entire conversation transcript

            // Access the caller number from the session object
            console.log('Final Caller Number:', session.callerNumber);

            await sendToWebhook({
                route: "2",  // Route 2 for sending the transcript
                data1: session.callerNumber,
                data2: session.transcript  // Send the transcript to the webhook
            });

            // Clean up the session
            sessions.delete(sessionId);  // Remove the session from the Map
        });

        // Handle WebSocket errors
        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);  // Log any errors in the OpenAI WebSocket
        });

        // Helper function for sending error responses
        function sendErrorResponse() {
            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: "I apologize, but I'm having trouble processing your request right now. Is there anything else I can help you with?",
                }
            }));
        }
    });
});

// Function to send data to the Make.com webhook
async function sendToWebhook(payload) {
    console.log('Sending data to webhook:', JSON.stringify(payload, null, 2));  // Log the data being sent
    try {
        const response = await fetch(MAKE_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'  // Set content type as JSON
            },
            body: JSON.stringify(payload)  // Send the payload as a JSON string
        });

        console.log('Webhook response status:', response.status);
        if (response.ok) {
            const responseText = await response.text();  // Get the text response from the webhook
            console.log('Webhook response:', responseText);
            return responseText;  // Return the response
        } else {
            console.error('Failed to send data to webhook:', response.statusText);
            throw new Error('Webhook request failed');  // Throw an error if the request fails
        }
    } catch (error) {
        console.error('Error sending data to webhook:', error);  // Log any errors in the request
        throw error;
    }
}

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);  // Exit if the server fails to start
    }
    console.log(`Server is listening on port ${PORT}`);  // Log the port the server is running on
});
