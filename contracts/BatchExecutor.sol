// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BatchExecutor
/// @notice EIP-7702 delegation target. When an EOA delegates to this contract, the EOA
///         becomes a smart account: it can execute batches of calls in a single transaction.
/// @dev The code runs in the EOA's account context, therefore `address(this)` is the EOA
///      itself. `execute` is intentionally callable only by the account (self-call), so the
///      implementation can never be used to drain an account by a third party.
contract BatchExecutor {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    event Executed(address indexed account, uint256 callCount, uint256 totalValue);
    event Received(address indexed from, uint256 amount);

    error NotSelf();
    error CallFailed(uint256 index, bytes reason);

    /// @notice Accept ETH so a delegated account can still be funded after delegation.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Execute a batch of calls from the delegated account.
    /// @param calls Array of {to, value, data} calls executed in order.
    /// @return results Raw return data of each call.
    function execute(Call[] calldata calls) external payable returns (bytes[] memory results) {
        if (msg.sender != address(this)) revert NotSelf();

        results = new bytes[](calls.length);
        uint256 totalValue;

        for (uint256 i; i < calls.length; ++i) {
            Call calldata call = calls[i];
            (bool ok, bytes memory ret) = call.to.call{value: call.value}(call.data);
            if (!ok) revert CallFailed(i, ret);
            results[i] = ret;
            totalValue += call.value;
        }

        emit Executed(msg.sender, calls.length, totalValue);
    }

    /// @notice ERC-1271 signature validation. The delegated EOA is the signer.
    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4 magicValue)
    {
        if (signature.length != 65) return 0xffffffff;

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;

        address recovered = ecrecover(hash, v, r, s);
        if (recovered != address(0) && recovered == address(this)) {
            return 0x1626ba7e;
        }
        return 0xffffffff;
    }

    /// @notice ERC-165 support: ERC-165 + ERC-1271.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x1626ba7e;
    }
}
