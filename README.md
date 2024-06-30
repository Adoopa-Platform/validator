# Validator

This serverless function is used to check whether an offer has met requirements for either completion or cancellation.

- If a reaction to the given offer's cast was created in time and the whole duration has passed, then Validator returns result=true with a signature to be able to complete the offer.
- If the reaction wasn't created in time or hasn't been created at all, then Validator returns result=false with a signature to be able to cancel the offer.
- If there is still time (during 24h since accepting) to perform a reaction or if reaction is present but duration hasn't passed yet, then Validator returns result=false without signature so that no action (complete/cancel) can be performed on the offer.

It uses the Neynar SDK to interact with Warpcast and the ethers.js library to interact with the Ethereum blockchain.
