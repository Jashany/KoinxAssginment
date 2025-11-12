import { Platform } from "react-native";
import dgram from "react-native-udp";
import { serviceEvents } from "./events";

type UDPSocket = ReturnType<typeof dgram.createSocket>;

interface RemoteInfo {
  address: string;
  family: string;
  port: number;
  size: number;
}

export const PORT = 43210;
export let BROADCAST_ADDR = "255.255.255.255";

let socket: UDPSocket | null = null;

/**
 * Initialise the UDP socket.
 * Call this **once** from a `useEffect` (client) or at server start.
 */
export async function initSocket(): Promise<UDPSocket> {
  if (socket) return socket;

  // ------------------------------------------------------------------
  // 1. Only run on platforms that actually support react-native-udp
  // ------------------------------------------------------------------
  if (
    Platform.OS !== "ios" &&
    Platform.OS !== "android" &&
    Platform.OS !== "web"
  ) {
    console.warn("UDP not supported on this platform – skipping init");
    // Return a dummy object so the rest of the code can still call .send()
    socket = {
      send: () => {},
      close: () => {},
    } as any;
    return socket as UDPSocket;
  }

  // ------------------------------------------------------------------
  // 2. Create the socket (no `debug` flag!)
  // ------------------------------------------------------------------
  const newSocket = dgram.createSocket({ type: "udp4" });

  // ------------------------------------------------------------------
  // 3. Bind + enable broadcast **after** we are listening
  // ------------------------------------------------------------------
  return new Promise<UDPSocket>((resolve, reject) => {
    newSocket.once("listening", () => {
      const address = newSocket.address();
      console.log(`UDP socket listening on ${address.address}:${address.port}`);

      // Enable broadcast *after* bind succeeds
      try {
        newSocket.setBroadcast(true);
      } catch (e) {
        console.warn("setBroadcast failed (some environments ignore it)", e);
      }

      socket = newSocket;
      resolve(newSocket);
    });

    newSocket.once("error", (err: any) => {
      console.error("UDP socket error during init:", err);
      reject(err);
    });

    // ----------------------------------------------------------------
    // 4. Message handling - emit string for CRDT processing
    // ----------------------------------------------------------------
    newSocket.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
      try {
        const messageStr = msg.toString();
        // Emit the string directly (will be parsed in state.ts)
        serviceEvents.emit("message", messageStr, rinfo);
      } catch (e) {
        console.error("Error processing UDP message:", e);
      }
    });

    // ----------------------------------------------------------------
    // 5. Bind to the port
    // ----------------------------------------------------------------
    try {
      newSocket.bind(PORT);
    } catch (e) {
      console.error("Failed to bind UDP socket:", e);
      reject(e);
    }
  });
}

/**
 * Send data to the current broadcast address.
 * @param data - The data to send (string or Buffer/Uint8Array)
 * @returns Promise that resolves when broadcast is sent
 */
export function sendDelta(data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socket) {
      console.warn("Socket not initialised – call initSocket() first");
      reject(new Error("Socket not initialized"));
      return;
    }

    // Convert string to Uint8Array if needed
    const message =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    // Send the message
    socket.send(
      message,
      0,
      message.length,
      PORT,
      BROADCAST_ADDR,
      (err?: Error | null) => {
        if (err) {
          console.error("Broadcast failed:", err);
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });
}

/**
 * Change broadcast target (useful for directed broadcasts).
 */
export function setBroadcastAddr(addr: string) {
  BROADCAST_ADDR = addr;
}

/**
 * Graceful shutdown (optional, call on app quit / unmount).
 */
export function closeSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
}
