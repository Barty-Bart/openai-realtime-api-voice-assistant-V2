// Import required modules
import Fastify from "fastify"; // Web framework for Node.js
import WebSocket from "ws"; // WebSocket library for real-time communication
import fs from "fs"; // Filesystem module for reading/writing files
import dotenv from "dotenv"; // Module to load environment variables from a .env file
import fastifyFormBody from "@fastify/formbody"; // Fastify plugin for parsing form data
import fastifyWs from "@fastify/websocket"; // Fastify plugin for WebSocket support
import { createClient } from "@supabase/supabase-js";

// Load environment variables from .env file
dotenv.config(); // Reads .env file and makes its variables available

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Retrieve the OpenAI API key from environment variables
const { OPENAI_API_KEY } = process.env; // Get the OpenAI API key from the environment

// Check if the API key is missing
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1); // Exit the application if the API key is not found
}

// Initialize Fastify server
const fastify = Fastify(); // Create a new Fastify instance
fastify.register(fastifyFormBody); // Register the form-body parsing plugin
fastify.register(fastifyWs); // Register WebSocket support for real-time communication

// System message template for the AI assistant's behavior and persona
const SYSTEM_MESSAGE = `
### Role
You are an AI assistant named Sophie, working at Bart's Automotive. Your role is to answer customer questions about automotive services and repairs, assist with booking tow services, and address customer complaints with empathy.
### Persona
- You have been a receptionist at Bart's Automotive for over 5 years.
- You are knowledgeable about both the company and cars in general.
- Your tone is friendly, professional, efficient, and empathetic.
- You keep conversations focused and concise, bringing them back on topic if necessary.
- You ask only one question at a time and respond promptly to avoid wasting the customer's time.
- Don't make any assumptions about any customer information! VERY IMPORTANT. DON'T GUESS ANYTHING
### Conversation Guidelines
- Always be polite and maintain a medium-paced speaking style.
- When the conversation veers off-topic, gently bring it back with a polite reminder.
- Address customer complaints with empathy and understanding.
### First Message
The first message you receive from the customer is their name and a summary of their last call, repeat this exact message to the customer as the greeting.
### Handling FAQs
Use the function \`question_and_answer\` to respond to common customer queries.
### Booking a Tow
When a customer needs a tow:
1. Ask for their current address.
2. Once you have the address, use the \`book_tow\` function to arrange the tow service.
### Handling Complaints
Use the function \`store_complaint\` to log customer complaints in the database.
`;

// Function to store complaints in Supabase
const sendComplaintToSupabase = async (callerNumber, complaint) => {
  try {
    const { data, error } = await supabase.from("company_call_logs").insert([
      {
        call_log_table_id: 1, // Using company_id 1 for mock purposes
        caller_phone: callerNumber,
        summary: complaint,
      },
    ]);

    if (error) throw error;
    console.log("Complaint stored successfully");
  } catch (error) {
    console.error("Error storing complaint:", error);
  }
};

// Function to retrieve the first message from Supabase
const getFirstMessageFromSupabase = async (callerNumber) => {
  try {
    const { data, error } = await supabase
      .from("voice_assistant_settings")
      .select("greeting_msg")
      .eq("company_id", 1) // Using company_id 1 for mock purposes
      .single();

    if (error) throw error;

    return (
      data.greeting_msg ||
      "Hello, welcome to Bart's Automotive. How can I assist you today?"
    );
  } catch (error) {
    console.error("Error retrieving first message:", error);
    return "Hello, welcome to Bart's Automotive. How can I assist you today?";
  }
};

// Some default constants used throughout the application
const VOICE = "alloy"; // The voice for AI responses
const PORT = process.env.PORT || 5050; // Set the port for the server (from environment or default to 5050)

// Session management: Store session data for ongoing calls
const sessions = new Map(); // A Map to hold session data for each call

// Event types to log to the console for debugging purposes
const LOG_EVENT_TYPES = [
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "response.text.done",
  "conversation.item.input_audio_transcription.completed",
];

// Root route - just for checking if the server is running
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" }); // Send a simple message when accessing the root
});

// Handle incoming calls from Twilio
fastify.all("/incoming-call", async (request, reply) => {
  console.log("Incoming call"); // Log incoming call for debugging

  // Get all incoming call details from the request body or query string
  const twilioParams = request.body || request.query;
  console.log("Twilio Inbound Details:", JSON.stringify(twilioParams, null, 2)); // Log call details

  // Extract caller's number and session ID (CallSid)
  const callerNumber = twilioParams.From || "Unknown"; // Caller phone number (default to 'Unknown' if missing)
  const sessionId = twilioParams.CallSid; // Use Twilio's CallSid as a unique session ID
  console.log("Caller Number:", callerNumber);
  console.log("Session ID (CallSid):", sessionId);

  // Retrieve the first message from Supabase
  const firstMessage = await getFirstMessageFromSupabase(callerNumber);

  // Set up a new session for this call
  let session = {
    transcript: "", // Store the conversation transcript here
    streamSid: null, // This will be set when the media stream starts
    callerNumber: callerNumber, // Store the caller's number
    callDetails: twilioParams, // Save the Twilio call details
    firstMessage: firstMessage, // Save the personalized first message
  };
  sessions.set(sessionId, session); // Add the session to the sessions Map

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

  reply.type("text/xml").send(twimlResponse); // Send the TwiML response to Twilio
});

// WebSocket route to handle the media stream for real-time interaction
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected to media-stream"); // Log when a client connects

    let firstMessage = ""; // Placeholder for the first message
    let streamSid = ""; // Placeholder for the stream ID
    let openAiWsReady = false; // Flag to check if the OpenAI WebSocket is ready
    let queuedFirstMessage = null; // Queue the first message until OpenAI WebSocket is ready
    let threadId = ""; // Initialize threadId for tracking conversation threads

    // Use Twilio's CallSid as the session ID or create a new one based on the timestamp
    const sessionId =
      req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    }; // Get the session data or create a new session
    sessions.set(sessionId, session); // Update the session Map

    // Retrieve the caller number from the session
    const callerNumber = session.callerNumber;
    console.log("Caller Number:", callerNumber);

    // Open a WebSocket connection to the OpenAI Realtime API
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`, // Authorization header with the OpenAI API key
          "OpenAI-Beta": "realtime=v1", // Use the beta realtime version
        },
      }
    );

    // Function to send the session configuration to OpenAI
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" }, // Enable voice activity detection
          input_audio_format: "g711_ulaw", // Audio format for input
          output_audio_format: "g711_ulaw", // Audio format for output
          voice: VOICE, // Use the defined voice for AI responses
          instructions: SYSTEM_MESSAGE, // Provide the AI assistant's instructions
          modalities: ["text", "audio"], // Use both text and audio for interaction
          temperature: 0.8, // Temperature for controlling the creativity of AI responses
          input_audio_transcription: {
            model: "whisper-1", // Use the Whisper model for transcribing audio
          },
          tools: [
            // Define the tools (functions) the AI can use
            {
              type: "function",
              name: "question_and_answer",
              description:
                "Get answers to customer questions about automotive services and repairs",
              parameters: {
                type: "object",
                properties: {
                  question: { type: "string" },
                },
                required: ["question"],
              },
            },
            {
              type: "function",
              name: "book_tow",
              description: "Book a tow service for a customer",
              parameters: {
                type: "object",
                properties: {
                  address: { type: "string" },
                },
                required: ["address"],
              },
            },
            {
              type: "function",
              name: "store_complaint",
              description: "Log customer complaints in the database",
              parameters: {
                type: "object",
                properties: {
                  complaint: { type: "string" },
                },
                required: ["complaint"],
              },
            },
          ],
          tool_choice: "auto", // Automatically choose the tool
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate)); // Send the session update to OpenAI
    };

    // Function to send the first message once OpenAI WebSocket is ready
    const sendFirstMessage = () => {
      if (queuedFirstMessage && openAiWsReady) {
        // Check if we have a queued message and the connection is ready
        console.log("Sending queued first message:", queuedFirstMessage);
        openAiWs.send(JSON.stringify(queuedFirstMessage)); // Send the first message
        openAiWs.send(JSON.stringify({ type: "response.create" })); // Trigger AI to generate a response
        queuedFirstMessage = null; // Clear the queue
      }
    };

    // Open event for when the OpenAI WebSocket connection is established
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API"); // Log successful connection
      openAiWsReady = true; // Set the flag to true
      sendSessionUpdate(); // Send session configuration
      sendFirstMessage(); // Send the first message if queued
    });

    // Handle messages from Twilio (media stream) and send them to OpenAI
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message); // Parse the incoming message from Twilio

        if (data.event === "start") {
          // When the call starts
          streamSid = data.start.streamSid; // Get the stream ID
          const callSid = data.start.callSid; // Get the call SID
          const customParameters = data.start.customParameters; // Get custom parameters (firstMessage, callerNumber)

          console.log("CallSid:", callSid);
          console.log("StreamSid:", streamSid);
          console.log("Custom Parameters:", customParameters);

          // Capture callerNumber and firstMessage from custom parameters
          const callerNumber = customParameters?.callerNumber || "Unknown";
          session.callerNumber = callerNumber; // Store the caller number in the session
          firstMessage =
            customParameters?.firstMessage || "Hello, how can I assist you?"; // Set the first message
          console.log("First Message:", firstMessage);
          console.log("Caller Number:", callerNumber);

          // Prepare the first message, but don't send it until the OpenAI connection is ready
          queuedFirstMessage = {
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: firstMessage }],
            },
          };

          if (openAiWsReady) {
            sendFirstMessage(); // Send the first message if OpenAI is ready
          }
        } else if (data.event === "media") {
          // When media (audio) is received
          if (openAiWs.readyState === WebSocket.OPEN) {
            // Check if the OpenAI WebSocket is open
            const audioAppend = {
              type: "input_audio_buffer.append", // Append audio data
              audio: data.media.payload, // Audio data from Twilio
            };
            openAiWs.send(JSON.stringify(audioAppend)); // Send the audio data to OpenAI
          }
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message); // Log any errors during message parsing
      }
    });

    // Handle incoming messages from OpenAI
    openAiWs.on("message", async (data) => {
      try {
        const response = JSON.parse(data); // Parse the message from OpenAI

        // Log error details if response failed
        if (
          response.type === "response.done" &&
          response.response.status === "failed"
        ) {
          console.error(
            "Response failed:",
            response.response.status_details.error
          );
        }

        // Handle audio responses from OpenAI
        if (response.type === "response.audio.delta" && response.delta) {
          connection.send(
            JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: response.delta }, // Send audio back to Twilio
            })
          );
        }

        //SEE IF THIS BREAKS ANYTHING - ADDEDUM
        if (response.type === "input_audio_buffer.speech_started") {
          console.log("Speech Start:", response.type);
          // Clear any ongoing speech on Twilio side
          connection.send(
            JSON.stringify({
              streamSid: streamSid,
              event: "clear",
            })
          );
          console.log("Cancelling AI speech from the server");

          // Send interrupt message to OpenAI to cancel ongoing response
          const interruptMessage = {
            type: "response.cancel",
          };
          openAiWs.send(JSON.stringify(interruptMessage));
        }

        // Handle function calls (for Q&A, booking a tow, and storing complaints)
        if (response.type === "response.function_call_arguments.done") {
          console.log("Function called:", response);
          const functionName = response.name;
          const args = JSON.parse(response.arguments); // Get the arguments passed to the function

          if (functionName === "store_complaint") {
            const complaint = args.complaint;
            try {
              await sendComplaintToSupabase(session.callerNumber, complaint);
              const functionOutputEvent = {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  role: "system",
                  output:
                    "Your complaint has been logged. We apologize for any inconvenience and will address it promptly.",
                },
              };
              openAiWs.send(JSON.stringify(functionOutputEvent));
            } catch (error) {
              console.error("Error storing complaint:", error);
              sendErrorResponse();
            }
          }
        }

        // Log agent response
        if (response.type === "response.done") {
          const agentMessage =
            response.response.output[0]?.content?.find(
              (content) => content.transcript
            )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`; // Add agent's message to the transcript
          console.log(`Agent (${sessionId}): ${agentMessage}`);
        }

        // Log user transcription (input_audio_transcription.completed)
        if (
          response.type ===
            "conversation.item.input_audio_transcription.completed" &&
          response.transcript
        ) {
          const userMessage = response.transcript.trim(); // Get the user's transcribed message
          session.transcript += `User: ${userMessage}\n`; // Add the user's message to the transcript
          console.log(`User (${sessionId}): ${userMessage}`);
        }

        // Log other relevant events
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle when the connection is closed
    connection.on("close", async () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close(); // Close the OpenAI WebSocket
      }
      console.log(`Client disconnected (${sessionId}).`);
      console.log("Full Transcript:");
      console.log(session.transcript); // Log the entire conversation transcript

      // Access the caller number from the session object
      console.log("Final Caller Number:", session.callerNumber);

      // Store the transcript in Supabase
      await sendToSupabase("company_call_logs", {
        call_log_table_id: 1, // Using company_id 1 for mock purposes
        caller_phone: session.callerNumber,
        summary: session.transcript,
        duration: 0, // You may want to calculate the actual duration
        email: null, // Add email if available
        caller_name: null, // Add caller name if available
      });

      // Clean up the session
      sessions.delete(sessionId); // Remove the session from the Map
    });

    // Handle WebSocket errors
    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error); // Log any errors in the OpenAI WebSocket
    });

    // Helper function for sending error responses
    function sendErrorResponse() {
      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text", "audio"],
            instructions:
              "I apologize, but I'm having trouble processing your request right now. Is there anything else I can help you with?",
          },
        })
      );
    }
  });
});

// Function to store data in Supabase
async function sendToSupabase(table, data) {
  try {
    const { data: result, error } = await supabase.from(table).insert([data]);

    if (error) throw error;
    console.log(`Data stored successfully in ${table}`);
  } catch (error) {
    console.error(`Error storing data in ${table}:`, error);
  }
}

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1); // Exit if the server fails to start
  }
  console.log(`Server is listening on port ${PORT}`); // Log the port the server is running on
});
