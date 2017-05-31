$(document).ready(function() {
    //empty array to store squares in
    squareArray = [0,0,0,0,0,0,0,0,0];
    
    //counters for player scores
    p1count = 0;
    p2count = 0;
    
    //stores div with specified ID with corresponding location in array
    var squareArrayStore = function(divID) {
        if (document.getElementById(divID).className === 'button x') {
            return 1;
        }
        else if (document.getElementById(divID).className === 'button o') {
            return 2;
        }
        else {
            return 0;
        }
    };
    
    //clears the board
    var clearboard = function() {
        $('div.x').removeClass('x');
        $('div.o').removeClass('o');
        squareArray = [0,0,0,0,0,0,0,0,0];
        playTally=0;
        computerTurn();
    }
    
    //checks if three squares are equal, gives alert if player has won
    var squareEqualCheck = function(num1,num2,num3,playerNum) {
        if (squareArray[num1] === squareArray[num2] && squareArray[num2] === squareArray[num3] && squareArray[num1] === playerNum) {
            $('#' + parseInt(num1)).toggleClass('threeinarow');
            $('#' + parseInt(num2)).toggleClass('threeinarow');
            $('#' + parseInt(num3)).toggleClass('threeinarow');
            if (playerNum === 1) {
                alert("Computer wins!");
                p1count++;
                clearboard();
            }
            else if (playerNum === 2) {
                alert("You win!");
                p2count++;
            }
            $('#p1score').text(p1count);
            $('#p2score').text(p2count);
            $('#' + parseInt(num1)).toggleClass('threeinarow');
            $('#' + parseInt(num2)).toggleClass('threeinarow');
            $('#' + parseInt(num3)).toggleClass('threeinarow');
            clearboard();
        }
    };
    
    //checks if a player has won the game
    var playerWonCheck = function(player) {
        squareEqualCheck(0,1,2,player);
        squareEqualCheck(3,4,5,player);
        squareEqualCheck(6,7,8,player);
        squareEqualCheck(0,3,6,player);
        squareEqualCheck(1,4,7,player);
        squareEqualCheck(2,5,8,player);
        squareEqualCheck(0,4,8,player);
        squareEqualCheck(2,4,6,player);
    };
    
    //toggles class of square and reflects the change in the array
    var changeSquare = function(squareNum){
        $('#'+squareNum).toggleClass('x');
        squareArray[squareNum]=1;
    };
    
    //check for move to complete three in a row
    var checkForThird = function(sq1,sq2,sq3){
        if (squareArray[sq1] === 1 && squareArray[sq2] === 1 && squareArray[sq3] === 0){
            changeSquare(sq3);
            playerWonCheck(1);
        }
    };
     
    //checks all three in a row combos
    var checkAllForThird = function(){
        checkForThird(0,2,1);
        checkForThird(0,6,3);
        checkForThird(0,8,4);
        checkForThird(2,6,4);
        checkForThird(2,8,5);
        checkForThird(6,8,7);
        checkForThird(6,4,2);
        checkForThird(8,4,0);
        checkForThird(2,4,6);
        checkForThird(0,4,8);
    };
    
    //check for available move for oponent to complete three in a row; blocks the move
    var checkOpponentThird = function(sq1,sq2,sq3){
        if (squareArray[sq1] === 2 && squareArray[sq2] === 2 && squareArray[sq3] === 0){
            changeSquare(sq3);
            playerWonCheck(1);
        }
    };
    
    //checks all opponent three in a row combos
    var checkAllOpponentThird = function(){
        checkOpponentThird(0,1,2);
        checkOpponentThird(0,2,1);
        checkOpponentThird(1,2,0);
        checkOpponentThird(3,4,5);
        checkOpponentThird(3,5,4);
        checkOpponentThird(4,5,3);
        checkOpponentThird(6,7,8);
        checkOpponentThird(6,8,7);
        checkOpponentThird(7,8,6);
        checkOpponentThird(0,3,6);
        checkOpponentThird(0,6,3);
        checkOpponentThird(3,6,0);
        checkOpponentThird(1,4,7);
        checkOpponentThird(1,7,4);
        checkOpponentThird(4,7,1);
        checkOpponentThird(2,5,8);
        checkOpponentThird(2,8,5);
        checkOpponentThird(5,8,2);
        checkOpponentThird(0,4,8);
        checkOpponentThird(0,8,4);
        checkOpponentThird(4,8,0);
        checkOpponentThird(2,4,6);
        checkOpponentThird(2,6,4);
        checkOpponentThird(4,6,2);
    };
            
    //computer's turn
    playTally = 0;
    var computerTurn = function(){
        //selects random corner on first and second turn
        if (playTally === 0){
            var randomCorner1 = Math.floor(Math.random()*4);
            if (randomCorner1 === 0){
                changeSquare(0);
            }
            else if (randomCorner1 === 1){
                changeSquare(2);
            }
            else if (randomCorner1 === 2){
                changeSquare(6);
            }
            else if (randomCorner1 === 3){
                changeSquare(8);
            }
            else{
                return;
            }
        }
        else if (playTally === 1){
            if (squareArray[0] === 0) {
                changeSquare(0);
            }
            else if (squareArray[2] === 0) {
                changeSquare(2);
            }
            else {
                changeSquare(6);
            }
        }
        else if (playTally === 2) {
            //if two X in a row, complete row
            checkAllForThird();
            //block opponent's three-in-a-row
            checkAllOpponentThird();
            //if neither condition is met, put X in center
            if (squareArray[4] === 0){
                changeSquare(4);
            }
        }
        else if (playTally > 2) {
            //if two X in a row, complete row
            checkAllForThird();
            //block opponent's three-in-a-row
            checkAllOpponentThird();
            //alert tie game
            alert("Tie game!")
            clearboard();
        }
        else {
            alert("Error!");
        }
    };
    computerTurn();
                 
    //buttons for the game
    $('div.button').click(function() {
        if (($('.x').length + $('.o').length) % 2 === 0) {
            $(this).toggleClass("x");
        }
        else {
            $(this).toggleClass("o");
            squareArray[$(this).attr('id')] = squareArrayStore($(this).attr('id'));
        }
        squareArray[$(this).attr('id')] = squareArrayStore($(this).attr('id'));
        playerWonCheck(1);
        playerWonCheck(2);
        playTally++;
        computerTurn();
    });
    
    $('div.clear').click(function() {
        clearboard();
    });
});